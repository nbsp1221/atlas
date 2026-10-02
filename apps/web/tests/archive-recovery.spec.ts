import { expect, test, type Page } from "@playwright/test"
import type { RunDetail } from "@workspace/domain"

const time = "2026-10-01T07:00:00.000Z"
function fixture(): RunDetail {
  return {
    id: "recovery-run",
    automationId: "email-triage",
    automationName: "Email Triage",
    occurredAt: time,
    sender: "Recovery Fixture",
    subject: "Archive recovery evidence",
    route: "archive",
    model: "fixture-model",
    latencyMs: 100,
    verification: "pending",
    mode: "test",
    status: "running",
    automationVersion: 1,
    senderEmail: "fixture@example.invalid",
    body: "Fixture",
    prompt: "fixture",
    reasonSummary: "Archive",
    usageDetails: {},
    costUsd: 0,
    action: "gmail.messages.modify",
    execution: "failed",
    evidence: "pending",
    input: {},
    output: null,
    error: null,
    definitionHash: "fixture-hash",
    modelInvocations: [],
    feedback: [],
    nodeExecutions: [
      {
        id: "archive-node",
        sequence: 1,
        nodeKey: "archive_email",
        nodeKind: "action",
        status: "running",
        retryOfNodeExecutionId: null,
        selectedEdgeKey: null,
        input: {},
        output: null,
        error: null,
        startedAt: time,
        finishedAt: null,
        implementation: null,
      },
    ],
    actionExecutions: [
      {
        id: "archive-action",
        nodeExecutionId: "archive-node",
        sequence: 1,
        connectionId: "fixture-connection",
        integrationKey: "gmail",
        actionKey: "messages.modify",
        executionStatus: "failed",
        verificationStatus: "pending",
        verifiedByNodeExecutionId: null,
        externalRef: "fixture-message",
        request: {},
        response: null,
        verificationEvidence: null,
        error: { code: "transient_failure" },
        startedAt: time,
        finishedAt: time,
        verifiedAt: null,
        archiveRecovery: {
          actionExecutionId: "archive-action",
          messageId: "fixture-message",
          initialRevision: "revision-1",
          state: "pending",
          nextOperation: "get",
          nextAttemptAt: "2026-10-01T07:00:01.000Z",
          deadlineAt: "2026-10-01T07:01:00.000Z",
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
          createdAt: time,
          updatedAt: time,
        },
        archiveAttempts: [
          {
            id: "event-1",
            actionExecutionId: "archive-action",
            sequence: 1,
            operation: "modify",
            phase: "started",
            attempt: 1,
            evidence: { messageId: "fixture-message" },
            createdAt: time,
          },
          {
            id: "event-2",
            actionExecutionId: "archive-action",
            sequence: 2,
            operation: "modify",
            phase: "interrupted",
            attempt: 1,
            evidence: { code: "dispatch_interrupted", outcome: "unknown" },
            createdAt: time,
          },
        ],
      },
    ],
  }
}

async function inspect(page: Page, run: RunDetail) {
  // All data is a local response fixture; these tests never write to a DB or
  // contact a provider, including when run in the regular isolated browser gate.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith("/api/auth/")) return route.continue()
    if (!path.startsWith("/api/")) return route.continue()
    await route.fulfill({
      json:
        path === `/api/runs/${run.id}`
          ? run
          : path === "/api/runs"
            ? [run]
            : [],
    })
  })
  await page.goto("/runs")
  await page.getByRole("button").filter({ hasText: run.subject }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByTestId("step-execution").locator("summary").first().click()
  const action = dialog.getByTestId("action-execution")
  await action.locator("summary").first().click()
  return { dialog, action, recovery: action.getByTestId("archive-recovery") }
}

test("pending recovery keeps failed write evidence and ordered expandable attempts", async ({
  page,
}) => {
  const { action, recovery } = await inspect(page, fixture())
  await expect(action.locator("summary").first()).toHaveText(
    "Action 1 · Archive recovery pending · write failed"
  )
  await expect(recovery).toContainText("Read message state")
  await expect(recovery).toContainText("Write attempts1 / 3")
  await expect(recovery).toContainText("Read attempts0 / 6")
  await expect(recovery).toContainText("Transient failure")
  const history = recovery.getByTestId("archive-attempt-history")
  await history.locator("summary").first().click()
  const events = history.getByTestId("archive-attempt-event")
  await expect(events).toHaveCount(2)
  await expect(events.nth(0).locator("summary")).toContainText(
    "1. Write (remove INBOX) · attempt 1 · dispatch started"
  )
  await expect(events.nth(1).locator("summary")).toContainText(
    "2. Write (remove INBOX) · attempt 1 · dispatch interrupted"
  )
  await events.nth(1).locator("summary").click()
  await expect(events.nth(1).locator("pre")).toContainText(
    '"outcome": "unknown"'
  )
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await page
    .getByRole("button")
    .filter({ hasText: "Archive recovery evidence" })
    .click()
  await expect(page.getByRole("dialog")).toBeVisible()
})

test("unknown write with readback shows verified state observation without causal success", async ({
  page,
}, testInfo) => {
  const run = fixture()
  Object.assign(run, {
    verification: "verified",
    execution: "unknown",
    status: "succeeded",
  })
  Object.assign(run.nodeExecutions[0], {
    status: "succeeded",
    finishedAt: time,
  })
  Object.assign(run.actionExecutions[0], {
    executionStatus: "unknown",
    verificationStatus: "verified",
    verifiedAt: time,
  })
  Object.assign(run.actionExecutions[0].archiveRecovery!, {
    state: "observed",
    nextAttemptAt: null,
    lastWriteOutcome: "unknown",
    readAttempts: 1,
    lastOutcome: {
      code: "desired_state_observed",
      causality: "not_established",
    },
  })
  const { action, recovery } = await inspect(page, run)
  await expect(action.locator("summary").first()).toHaveText(
    "Action 1 · Verified state observation · write unknown"
  )
  await expect(recovery).toContainText(
    "does not establish that this write caused it"
  )
  await expect(recovery).toContainText("The write outcome remains unknown")
  await expect(recovery).toContainText("None · recovery finished")
  await expect(recovery).toContainText("Not scheduled")
  await recovery.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath("observed-state-unknown-write.png"),
    fullPage: true,
  })
})

test("stopped recovery never labels stale action verification as Verified", async ({
  page,
}) => {
  const run = fixture()
  Object.assign(run, { verification: "failed", status: "failed" })
  Object.assign(run.actionExecutions[0], {
    executionStatus: "succeeded",
    verificationStatus: "verified",
  })
  Object.assign(run.actionExecutions[0].archiveRecovery!, {
    state: "stopped",
    nextAttemptAt: null,
    lastOutcome: { code: "intent_superseded" },
  })
  const { action, recovery } = await inspect(page, run)
  await expect(action.locator("summary").first()).toHaveText(
    "Action 1 · Archive recovery stopped · write succeeded"
  )
  await expect(recovery).toContainText("Intent superseded")
  await expect(recovery).not.toContainText("Verified state observation")
  await expect(recovery).toContainText("None · recovery finished")
})

test("historical action without recovery fields still renders", async ({
  page,
}) => {
  const run = fixture()
  delete run.actionExecutions[0].archiveRecovery
  delete run.actionExecutions[0].archiveAttempts
  const { action, recovery } = await inspect(page, run)
  await expect(action.locator("summary").first()).toHaveText(
    "Action 1 · failed · verification pending"
  )
  await expect(recovery).toHaveCount(0)
  await expect(action.getByText("Action execution evidence")).toBeVisible()
})

test("pending recovery stays readable at mobile width", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { recovery } = await inspect(page, fixture())
  await recovery.scrollIntoViewIfNeeded()
  await expect(recovery).toContainText("Archive recovery pending")
  await expect(recovery.getByText("Next due", { exact: true })).toBeVisible()
  expect(
    await recovery.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath("pending-recovery-mobile.png"),
    fullPage: true,
  })
})
