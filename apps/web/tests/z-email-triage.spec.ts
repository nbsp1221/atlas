import { verificationEvidenceDirectory } from "../../../scripts/verification-isolation.mjs"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import type { RunDetail } from "@workspace/domain"

// These classifications are artificial fixture answers, never a real-user policy
// or a measurement of real model accuracy. All requests use the actual product API.
const path = "/api/automations/email-triage/test-runs"
const evidenceDirectory = verificationEvidenceDirectory("email-triage")
function email(id: string) {
  return {
    messageId: id,
    sender: { name: "Fixture Sender", address: "fixture@example.invalid" },
    subject: `Atlas mail fixture: ${id}`,
    text: `Artificial mail content for ${id}; no real account or person.`,
  }
}
type Scenario = {
  route?: "archive" | "no_action"
  confidence?: number
  reasonSummary?: string
  modelTransientFailures?: number
  modelPermanentFailure?: boolean
  malformedModelOutput?: boolean
  modelOutputOverride?: unknown
  actionBehavior?: "success" | "failure" | "unknown"
  archiveEffect?: "apply" | "omit"
  initiallyArchived?: boolean
  verificationTransientFailures?: number
  disableExternalActions?: boolean
  modelDelayMs?: number
}
const cases: Array<{
  name: string
  scenario: Scenario
  status: "succeeded" | "failed"
  archived: boolean
  nodes: number
  models: number
  attempts: number
  reads: number
  verification: string
  execution: string
  gap?: string
}> = [
  {
    name: "normal-archive",
    scenario: { route: "archive" },
    status: "succeeded",
    archived: true,
    nodes: 4,
    models: 1,
    attempts: 1,
    reads: 1,
    verification: "verified",
    execution: "succeeded",
  },
  {
    name: "retain-important",
    scenario: { route: "no_action" },
    status: "succeeded",
    archived: false,
    nodes: 3,
    models: 1,
    attempts: 0,
    reads: 0,
    verification: "completed",
    execution: "none",
  },
  {
    name: "uncertain-retain",
    scenario: { route: "no_action", confidence: 0.2 },
    status: "succeeded",
    archived: false,
    nodes: 3,
    models: 1,
    attempts: 0,
    reads: 0,
    verification: "completed",
    execution: "none",
  },
  {
    name: "transient-model-retry",
    scenario: { route: "archive", modelTransientFailures: 2 },
    status: "succeeded",
    archived: true,
    nodes: 4,
    models: 3,
    attempts: 1,
    reads: 1,
    verification: "verified",
    execution: "succeeded",
  },
  {
    name: "permanent-model-error",
    scenario: { route: "archive", modelPermanentFailure: true },
    status: "failed",
    archived: false,
    nodes: 2,
    models: 1,
    attempts: 0,
    reads: 0,
    verification: "failed",
    execution: "none",
  },
  {
    name: "invalid-model-output",
    scenario: { route: "archive", malformedModelOutput: true },
    status: "failed",
    archived: false,
    nodes: 2,
    models: 1,
    attempts: 0,
    reads: 0,
    verification: "failed",
    execution: "none",
  },
  {
    name: "undefined-model-route",
    scenario: {
      route: "archive",
      modelOutputOverride: { route: "delete_everything", confidence: 1 },
    },
    status: "failed",
    archived: false,
    nodes: 2,
    models: 1,
    attempts: 0,
    reads: 0,
    verification: "failed",
    execution: "none",
  },
  {
    name: "model-retry-exhausted",
    scenario: { route: "archive", modelTransientFailures: 3 },
    status: "failed",
    archived: false,
    nodes: 2,
    models: 3,
    attempts: 0,
    reads: 0,
    verification: "failed",
    execution: "none",
  },
  {
    name: "archive-failure",
    scenario: { route: "archive", actionBehavior: "failure" },
    status: "failed",
    archived: false,
    nodes: 4,
    models: 1,
    attempts: 1,
    reads: 0,
    verification: "failed",
    execution: "failed",
  },

  {
    name: "unknown-after-effect",
    scenario: {
      route: "archive",
      actionBehavior: "unknown",
      archiveEffect: "apply",
    },
    status: "succeeded",
    archived: true,
    nodes: 4,
    models: 1,
    attempts: 1,
    reads: 1,
    verification: "verified",
    execution: "unknown",
    gap: "Mailbox changed, but product correctly remains unknown; automatic reconciliation absent",
  },
  {
    name: "already-archived",
    scenario: { route: "archive", initiallyArchived: true },
    status: "succeeded",
    archived: true,
    nodes: 4,
    models: 1,
    attempts: 1,
    reads: 1,
    verification: "verified",
    execution: "succeeded",
  },
  {
    name: "verification-mismatch",
    scenario: { route: "archive", archiveEffect: "omit" },
    status: "failed",
    archived: false,
    nodes: 4,
    models: 1,
    attempts: 1,
    reads: 1,
    verification: "failed",
    execution: "succeeded",
  },

  {
    name: "external-writes-disabled",
    scenario: { route: "archive", disableExternalActions: true },
    status: "succeeded",
    archived: false,
    nodes: 4,
    models: 1,
    attempts: 0,
    reads: 0,
    verification: "completed",
    execution: "none",
  },
  {
    name: "low-confidence-archive-policy-gap",
    scenario: { route: "archive", confidence: 0.1 },
    status: "succeeded",
    archived: true,
    nodes: 4,
    models: 1,
    attempts: 1,
    reads: 1,
    verification: "verified",
    execution: "succeeded",
    gap: "Confidence is evidence only; no user-approved threshold/uncertainty retention policy exists",
  },
]

test("fake mailbox matrix crosses API, engine, persistent store and readable UI", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await mkdir(evidenceDirectory, { recursive: true })
  const baseline = await (await page.request.get("/api/overview")).json()
  const automationBefore = await (
    await page.request.get("/api/automations/email-triage")
  ).json()
  const results: unknown[] = []
  const failures: string[] = []
  const byName = new Map<string, RunDetail>()
  for (const fixture of cases) {
    const input = email(fixture.name)
    const create = await page.request.post(path, {
      data: {
        version: automationBefore.version,
        email: input,
        scenario: {
          reasonSummary: `Artificial fixture decision: ${fixture.name}`,
          ...fixture.scenario,
        },
      },
    })
    const created = await create.json()
    const read = created.runId
      ? await page.request.get(`/api/runs/${created.runId}`)
      : null
    let detail: RunDetail | null = read ? await read.json() : null
    try {
      expect(create.status()).toBe(201)
      expect(read?.status()).toBe(200)
      expect(detail).not.toBeNull()
      if (created.status === "running") {
        // A background recovery worker can own the action when POST returns.
        // Prove the terminal result through readback without disabling workers.
        await expect
          .poll(
            async () => {
              const response = await page.request.get(
                `/api/runs/${created.runId}`
              )
              expect(response.status()).toBe(200)
              detail = await response.json()
              return detail?.status
            },
            { timeout: 5_000 }
          )
          .toBe(fixture.status)
      }
      const persisted = detail!
      byName.set(fixture.name, persisted)
      expect([fixture.status, "running"]).toContain(created.status)
      expect(created.simulation.environment).toBe("fake")
      expect(created.simulation.mailboxBefore).toEqual([
        {
          messageId: input.messageId,
          inInbox: !fixture.scenario.initiallyArchived,
          archived: !!fixture.scenario.initiallyArchived,
          spam: false,
        },
      ])
      if (created.status !== "running")
        expect(created.simulation.mailboxAfter).toEqual([
          {
            messageId: input.messageId,
            inInbox: !fixture.archived,
            archived: fixture.archived,
            spam: false,
          },
        ])
      if (created.status !== "running") {
        expect(created.simulation.archiveAttempts).toBe(fixture.attempts)
        expect(created.simulation.archiveVerificationReads).toBe(fixture.reads)
      }
      if (fixture.attempts > 0) {
        expect(
          persisted.actionExecutions[0].archiveRecovery?.writeAttempts
        ).toBe(fixture.attempts)
        expect(
          persisted.actionExecutions[0].archiveRecovery?.readAttempts
        ).toBe(fixture.reads)
      }
      expect(created.simulation.notificationCount).toBe(0)
      expect(created.simulation.modelRequests).toHaveLength(fixture.models)
      expect(persisted).toMatchObject({
        mode: "test",
        status: fixture.status,
        input,
        sender: "Fixture Sender",
        senderEmail: input.sender.address,
        body: input.text,
        automationVersion: automationBefore.version,
        definitionHash: automationBefore.definitionHash,
        verification: fixture.verification,
        execution: fixture.execution,
      })
      expect(persisted.nodeExecutions).toHaveLength(fixture.nodes)
      expect(persisted.modelInvocations).toHaveLength(fixture.models)
      expect(persisted.actionExecutions).toHaveLength(fixture.attempts)
      const classifier = persisted.nodeExecutions.find(
        (node) => node.nodeKey === "classify_email"
      )!
      for (const [index, model] of persisted.modelInvocations.entries()) {
        expect(model.nodeExecutionId).toBe(classifier.id)
        expect(model.sequence).toBe(index + 1)
        expect(model.input).toEqual(
          created.simulation.modelRequests[index].input
        )
        expect(model.finishedAt).not.toBeNull()
        expect(model.input).toMatchObject({ email: input })
      }
      expect(persisted.nodeExecutions.map((node) => node.sequence)).toEqual(
        Array.from({ length: fixture.nodes }, (_, i) => i + 1)
      )
      expect(
        persisted.nodeExecutions.every((node) => node.finishedAt !== null)
      ).toBe(true)
      expect(
        persisted.nodeExecutions.some((node) =>
          ["notify_user", "report_spam"].includes(node.nodeKey)
        )
      ).toBe(false)
      if (fixture.attempts > 0) {
        const action = persisted.actionExecutions[0]
        const node = persisted.nodeExecutions.find(
          (candidate) => candidate.nodeKey === "archive_email"
        )!
        expect(action).toMatchObject({
          nodeExecutionId: node.id,
          integrationKey: "gmail",
          actionKey: "archive-message",
          request: { messageId: input.messageId },
          executionStatus: fixture.execution,
        })
        if (fixture.reads > 0) {
          expect(action.verificationEvidence).toMatchObject({
            messageId: input.messageId,
            inInbox: !fixture.archived,
          })
          expect(
            persisted.nodeExecutions.find(
              (candidate) => candidate.id === action.verifiedByNodeExecutionId
            )?.nodeKey
          ).toBe("verify_archive")
        } else {
          expect(action.verificationStatus).toBe("failed")
          expect(action.verificationEvidence).toMatchObject({
            code: "permanent_failure",
          })
          expect(action.verifiedByNodeExecutionId).not.toBeNull()
        }
      }
      if (fixture.name === "external-writes-disabled") {
        expect(
          persisted.nodeExecutions.slice(2).map((node) => node.status)
        ).toEqual(["skipped", "skipped"])
      }
      results.push({
        name: fixture.name,
        assertion: "PASS",
        scope: fixture.gap ? "GAP OBSERVED" : "PASS",
        gap: fixture.gap ?? null,
        expected: fixture,
        actual: created,
        persisted,
      })
    } catch (error) {
      failures.push(`${fixture.name}: ${String(error)}`)
      results.push({
        name: fixture.name,
        assertion: "FAIL",
        expected: fixture,
        actual: created,
        persisted: detail,
        error: String(error),
      })
    }
    await writeFile(
      `${evidenceDirectory}/matrix.json`,
      JSON.stringify(results, null, 2)
    )
  }
  expect(failures).toEqual([])
  expect(await (await page.request.get("/api/overview")).json()).toEqual(
    baseline
  )
  const automationAfter = await (
    await page.request.get("/api/automations/email-triage")
  ).json()
  expect(automationAfter).toEqual(automationBefore)
  await writeFile(
    `${evidenceDirectory}/isolation.json`,
    JSON.stringify(
      {
        baseline,
        after: await (await page.request.get("/api/overview")).json(),
        automationBefore,
        automationAfter,
      },
      null,
      2
    )
  )

  for (const name of [
    "normal-archive",
    "transient-model-retry",
    "unknown-after-effect",
    "verification-mismatch",
    "retain-important",
  ]) {
    const detail = byName.get(name)!
    await page.goto("/runs")
    await page
      .getByRole("button")
      .filter({ hasText: email(name).subject })
      .click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText("Execution log", { exact: true })
    ).toBeVisible()
    await expect(dialog.getByTestId("step-execution")).toHaveCount(
      detail.nodeExecutions.length
    )
    await dialog
      .getByTestId("step-execution")
      .nth(1)
      .locator("summary")
      .first()
      .click()
    await expect(dialog.getByTestId("model-invocation")).toHaveCount(
      detail.modelInvocations.length
    )
    await dialog
      .getByTestId("model-invocation")
      .last()
      .locator("summary")
      .click()
    await expect(
      dialog.getByText("Model invocation evidence", { exact: true }).last()
    ).toBeVisible()
    await expect(
      dialog
        .locator("pre")
        .filter({ hasText: email(name).subject })
        .first()
    ).toBeVisible()
    await page.screenshot({
      path: `${evidenceDirectory}/${name}-model.png`,
      fullPage: true,
    })
    if (detail.actionExecutions.length) {
      await dialog
        .getByTestId("step-execution")
        .nth(2)
        .locator("summary")
        .first()
        .click()
      await dialog
        .getByTestId("action-execution")
        .locator("summary")
        .first()
        .click()
      await dialog
        .getByText("Action execution evidence", { exact: true })
        .scrollIntoViewIfNeeded()
      await expect(dialog.getByTestId("action-execution")).toContainText(
        detail.execution
      )
      await expect(dialog.getByTestId("action-execution")).toContainText(
        detail.actionExecutions[0].verificationStatus
      )
      await page.screenshot({
        path: `${evidenceDirectory}/${name}-action.png`,
        fullPage: true,
      })
    }
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
  }
})

test("empty input, repeated manual fixture, and concurrent fake models expose exact contract limits", async ({
  page,
}) => {
  await mkdir(evidenceDirectory, { recursive: true })
  const before = await (await page.request.get("/api/runs")).json()
  const empty = await page.request.post(path, { data: { emails: [] } })
  expect(empty.status()).toBe(400)
  expect(await (await page.request.get("/api/runs")).json()).toEqual(before)

  const repeated = []
  for (const initiallyArchived of [false, true]) {
    const response = await page.request.post(path, {
      data: {
        email: email("repeated-event"),
        scenario: { route: "archive", initiallyArchived },
      },
    })
    expect(response.status()).toBe(201)
    repeated.push(await response.json())
  }
  expect(repeated[0].runId).not.toBe(repeated[1].runId)
  expect(repeated.map((value) => value.simulation.archiveAttempts)).toEqual([
    1, 1,
  ])
  expect(
    repeated.map((value) => value.simulation.mailboxAfter[0].inInbox)
  ).toEqual([false, false])

  const concurrent = await Promise.all(
    [
      { id: "concurrent-archive", route: "archive", delay: 100, retry: 1 },
      { id: "concurrent-retain", route: "no_action", delay: 5, retry: 0 },
    ].map(async (fixture) => {
      const response = await page.request.post(path, {
        data: {
          email: email(fixture.id),
          scenario: {
            route: fixture.route,
            modelDelayMs: fixture.delay,
            modelTransientFailures: fixture.retry,
          },
        },
      })
      expect(response.status()).toBe(201)
      const created = await response.json()
      const detail = await (
        await page.request.get(`/api/runs/${created.runId}`)
      ).json()
      expect(detail.route).toBe(fixture.route)
      expect(detail.modelInvocations).toHaveLength(1 + fixture.retry)
      expect(detail.actionExecutions).toHaveLength(
        fixture.route === "archive" ? 1 : 0
      )
      for (const model of detail.modelInvocations)
        expect(model.input.email.messageId).toBe(fixture.id)
      return { fixture, created, persisted: detail }
    })
  )
  await writeFile(
    `${evidenceDirectory}/contract-limits.json`,
    JSON.stringify(
      {
        emptyMailbox: {
          http: empty.status(),
          body: await empty.json(),
          gap: "Single-email endpoint has no mailbox polling/batch or empty-mailbox run contract; rejected before persistence",
        },
        noEligibleMailbox: {
          gap: "No mailbox selector is wired to Email Triage; retain fixture covers individual no_action only. The separate email-summary filter is not this flow.",
        },
        repeatedManualFixture: {
          actual: repeated,
          gap: "Manual fixture requests intentionally create two Runs and two attempts. Explicit event admission is tested separately. Second fake world is explicitly initialized archived, not shared persistent mailbox state.",
        },
        concurrent,
      },
      null,
      2
    )
  )
})
