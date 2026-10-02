import assert from "node:assert/strict"
import test from "node:test"
import { runActionExecutionSchema, runDetailSchema } from "@workspace/domain"
import {
  runDetailReadModel,
  runListReadModels,
  overviewReadModel,
} from "../src/read-models"

type Bundle = Parameters<typeof runDetailReadModel>[0]
const now = new Date("2026-10-01T07:00:00.000Z")

function bundle(): Bundle {
  return {
    automation: {
      id: "automation",
      key: "email-triage",
      name: "Email Triage",
      description: null,
      status: "active",
      activeVersionId: "version",
      createdAt: now,
      updatedAt: now,
    },
    version: {
      id: "version",
      automationId: "automation",
      versionNumber: 1,
      definitionSchemaVersion: 1,
      graphDefinition: { schemaVersion: 1, nodes: [], edges: [] },
      definitionHash: "hash",
      sourceRevision: null,
      createdAt: now,
    },
    run: {
      id: "run",
      automationId: "automation",
      automationVersionId: "version",
      mode: "test",
      status: "running",
      triggerIntegrationKey: null,
      triggerConnectionId: null,
      idempotencyKey: null,
      parentNodeExecutionId: null,
      replayOfRunId: null,
      triggerSnapshot: null,
      inputSnapshot: { subject: "Recovery" },
      outputSnapshot: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    },
    nodes: [
      {
        id: "node",
        runId: "run",
        sequence: 1,
        nodeKey: "archive_email",
        nodeKind: "action",
        status: "running",
        retryOfNodeExecutionId: null,
        selectedEdgeKey: null,
        inputSnapshot: {},
        outputSnapshot: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      },
    ],
    models: [],
    feedback: [],
    actions: [
      {
        id: "action",
        nodeExecutionId: "node",
        sequence: 1,
        connectionId: "connection",
        integrationKey: "gmail",
        actionKey: "messages.modify",
        idempotencyKey: "archive-intent",
        executionStatus: "failed",
        verificationStatus: "pending",
        verifiedByNodeExecutionId: null,
        externalRef: "message",
        requestSnapshot: {},
        responseSnapshot: null,
        verificationEvidence: null,
        error: { code: "transient" },
        startedAt: now,
        finishedAt: now,
        verifiedAt: null,
      },
    ],
    archiveRecoveries: [
      {
        actionExecutionId: "action",
        messageId: "message",
        initialRevision: "revision-1",
        state: "pending",
        nextOperation: "get",
        nextAttemptAt: new Date(now.getTime() + 1000),
        deadlineAt: new Date(now.getTime() + 60000),
        policy: {
          maxWrites: 3,
          maxReads: 6,
          deadlineMs: 60000,
          baseDelayMs: 1000,
          maxDelayMs: 8000,
        },
        writeAttempts: 1,
        readAttempts: 0,
        inFlightOperation: null,
        inFlightAttempt: null,
        writeRetryAllowed: true,
        writeNotBeforeAt: null,
        lastWriteOutcome: "failed",
        lastOutcome: { code: "transient_failure" },
        createdAt: now,
        updatedAt: now,
      },
    ],
    archiveAttempts: [
      {
        id: "event-2",
        actionExecutionId: "action",
        sequence: 2,
        operation: "modify",
        phase: "result",
        attempt: 1,
        evidence: { kind: "unknown" },
        createdAt: now,
      },
      {
        id: "foreign-event",
        actionExecutionId: "another-action",
        sequence: 1,
        operation: "modify",
        phase: "started",
        attempt: 1,
        evidence: {},
        createdAt: now,
      },
      {
        id: "event-1",
        actionExecutionId: "action",
        sequence: 1,
        operation: "modify",
        phase: "started",
        attempt: 1,
        evidence: {},
        createdAt: now,
      },
    ],
  }
}

function list(input: Bundle) {
  return runListReadModels({
    ...input,
    rows: [
      { run: input.run, automation: input.automation, version: input.version },
    ],
  })[0]
}

function overview(input: Bundle) {
  return overviewReadModel({ ...input, runs: [input.run] })
}

test("pending archive recovery overrides the transient failed write in read models", () => {
  const input = bundle()
  const detail = runDetailReadModel(input)
  assert.equal(detail.verification, "pending")
  assert.equal(detail.execution, "failed", "retain actual last write evidence")
  assert.equal(list(input).verification, "pending")
  assert.equal(overview(input).verifiedOutcomes, 0)
  assert.equal(overview(input).attentionCount, 1)
  assert.equal(
    detail.actionExecutions[0].archiveRecovery?.nextAttemptAt,
    "2026-10-01T07:00:01.000Z"
  )
  assert.deepEqual(
    detail.actionExecutions[0].archiveAttempts?.map((event) => event.id),
    ["event-1", "event-2"]
  )
  assert.deepEqual(
    input.archiveAttempts?.map((event) => event.id),
    ["event-2", "foreign-event", "event-1"],
    "mapping never mutates immutable evidence order"
  )
  assert.equal(runDetailSchema.safeParse(detail).success, true)
})

test("verified state observation retains the unknown write instead of claiming success", () => {
  const input = bundle()
  const recovery = input.archiveRecoveries![0]
  Object.assign(recovery, {
    state: "observed",
    nextAttemptAt: null,
    lastWriteOutcome: "unknown",
    readAttempts: 1,
    lastOutcome: {
      code: "desired_state_observed",
      causality: "not_established",
    },
  })
  Object.assign(input.actions[0], {
    executionStatus: "unknown",
    verificationStatus: "verified",
    verifiedAt: now,
  })
  const detail = runDetailReadModel(input)
  assert.equal(detail.verification, "verified")
  assert.equal(detail.execution, "unknown")
  assert.equal(detail.actionExecutions[0].executionStatus, "unknown")
  assert.equal(
    detail.actionExecutions[0].archiveRecovery?.lastWriteOutcome,
    "unknown"
  )
  assert.equal(list(input).verification, "verified")
  assert.equal(overview(input).verifiedOutcomes, 1)
  assert.equal(overview(input).attentionCount, 0)
})

test("stopped archive recovery can never be presented as Verified", () => {
  const input = bundle()
  Object.assign(input.archiveRecoveries![0], {
    state: "stopped",
    nextAttemptAt: null,
  })
  Object.assign(input.actions[0], {
    executionStatus: "succeeded",
    verificationStatus: "verified",
    verifiedAt: now,
  })
  assert.equal(runDetailReadModel(input).verification, "failed")
  assert.equal(list(input).verification, "failed")
  assert.equal(overview(input).verifiedOutcomes, 0)
  assert.equal(overview(input).attentionCount, 1)
})

test("legacy actions keep their old status and accept absent recovery fields", () => {
  const input = bundle()
  delete input.archiveRecoveries
  delete input.archiveAttempts
  const detail = runDetailReadModel(input)
  assert.equal(detail.verification, "failed")
  const action = detail.actionExecutions[0]
  assert.equal(action.archiveRecovery, null)
  assert.deepEqual(action.archiveAttempts, [])
  delete action.archiveRecovery
  delete action.archiveAttempts
  assert.equal(runActionExecutionSchema.safeParse(action).success, true)
})

test("recovery evidence from another logical action cannot change this run", () => {
  const input = bundle()
  input.archiveRecoveries![0].actionExecutionId = "another-action"
  assert.equal(runDetailReadModel(input).verification, "failed")
  assert.equal(
    runDetailReadModel(input).actionExecutions[0].archiveRecovery,
    null
  )
  assert.equal(list(input).verification, "failed")
})

test("an initial pending archive action is running, never a succeeded write", () => {
  const input = bundle()
  input.actions[0].executionStatus = "running"
  input.actions[0].finishedAt = null
  Object.assign(input.archiveRecoveries![0], {
    nextOperation: "modify",
    writeAttempts: 0,
    lastWriteOutcome: null,
    lastOutcome: null,
  })
  const detail = runDetailReadModel(input)
  assert.equal(detail.verification, "pending")
  assert.equal(detail.execution, "running")
  assert.equal(runDetailSchema.safeParse(detail).success, true)
})
