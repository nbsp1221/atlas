import { verificationEvidenceDirectory } from "../../../scripts/verification-isolation.mjs"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test("duplicate event keeps one persisted archive and one readable run", async ({
  page,
}) => {
  const path = "/api/automations/email-triage/test-runs"
  const body = {
    email: {
      messageId: "ui-admitted-message",
      sender: {
        name: "Admission Fixture",
        address: "admission@example.invalid",
      },
      subject: "Message admission UI proof",
      text: "Fake event repeated through the actual HTTP and database path.",
    },
    scenario: { route: "archive" },
    execution: {
      kind: "event",
      mailbox: {
        integrationKey: "gmail",
        resourceType: "mailbox",
        externalId: "ui-fixture-mailbox",
      },
      historyId: "history-1",
      notificationId: "delivery-1",
    },
  }
  const first = await page.request.post(path, { data: body })
  expect(first.status()).toBe(201)
  const admitted = await first.json()
  expect(admitted.admission).toBe("created")
  expect(admitted.simulation.archiveAttempts).toBe(1)
  const before = await (
    await page.request.get(`/api/runs/${admitted.runId}`)
  ).json()
  const repeat = await page.request.post(path, {
    data: {
      ...body,
      execution: {
        ...body.execution,
        historyId: "history-2",
        notificationId: "delivery-2",
      },
    },
  })
  expect(repeat.status()).toBe(200)
  const duplicate = await repeat.json()
  expect(duplicate).toMatchObject({
    runId: admitted.runId,
    admission: "duplicate",
    status: "succeeded",
    version: admitted.version,
    simulation: null,
  })
  const after = await (
    await page.request.get(`/api/runs/${admitted.runId}`)
  ).json()
  expect(after).toEqual(before)
  expect(after.nodeExecutions).toHaveLength(4)
  expect(after.modelInvocations).toHaveLength(1)
  expect(after.actionExecutions).toHaveLength(1)
  expect(after.actionExecutions[0]).toMatchObject({
    executionStatus: "succeeded",
    verificationStatus: "verified",
  })
  await page.goto("/runs")
  const row = page.getByRole("button").filter({ hasText: body.email.subject })
  await expect(row).toHaveCount(1)
  await row.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Execution log", { exact: true })).toBeVisible()
  await expect(dialog.getByTestId("step-execution")).toHaveCount(4)
  await dialog
    .getByTestId("step-execution")
    .nth(2)
    .locator("summary")
    .first()
    .click()
  await expect(dialog.getByTestId("action-execution")).toHaveCount(1)
  await expect(dialog.getByTestId("action-execution")).toContainText("verified")
  await mkdir(verificationEvidenceDirectory("message-admission"), {
    recursive: true,
  })
  await writeFile(
    `${verificationEvidenceDirectory("message-admission")}/ui-evidence.json`,
    JSON.stringify({ admitted, duplicate, persisted: after }, null, 2)
  )
  await page.screenshot({
    path: `${verificationEvidenceDirectory("message-admission")}/message-admission.png`,
    fullPage: true,
  })
})
