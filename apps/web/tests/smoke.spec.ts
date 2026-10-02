import { verificationEvidenceDirectory } from "../../../scripts/verification-isolation.mjs"
import { expect, test } from "@playwright/test"

test.describe.configure({ mode: "serial" })

test("overview is rendered from the bootstrapped database", async ({
  page,
}) => {
  const response = await page.request.get("/api/overview")
  expect(response.ok()).toBe(true)
  expect(await response.json()).toMatchObject({
    runs24h: 0,
    failed24h: 0,
    verifiedOutcomes: 0,
    totalOutcomes: 0,
    cost24hUsd: 0,
    attentionCount: 0,
  })

  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  await expect(page.getByText("NO RUN DATA", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Email Triage", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText("PAUSED", { exact: true }).first()).toBeVisible()
})

test("automation graph comes from the active AutomationVersion", async ({
  page,
}) => {
  await page.goto("/automations/email-triage")
  await expect(
    page.getByRole("heading", { name: "Email Triage" })
  ).toBeVisible()
  await expect(page.getByText("PAUSED", { exact: true })).toBeVisible()
  await expect(page.locator(".react-flow__node")).toHaveCount(9)

  await page.locator(".react-flow__node").filter({ hasText: "Notify" }).click()
  const inspector = page.locator("aside").last()
  await expect(inspector.getByText("Notify", { exact: true })).toBeVisible()
  await expect(inspector.getByText("neutral", { exact: true })).toBeVisible()
})

test("runs start empty rather than using fixture data", async ({ page }) => {
  await page.goto("/runs")
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible()
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible()
})

test("fake adapters execute a full test run and surface evidence in the UI", async ({
  page,
}) => {
  const create = await page.request.post(
    "/api/automations/email-triage/test-runs",
    {
      data: {
        email: {
          messageId: "playwright-notify-1",
          sender: {
            name: "Toss Support",
            address: "support@example.com",
          },
          subject: "Playwright fake runtime reply",
          text: "This email is executed against provider-independent fake adapters.",
        },
        scenario: {
          route: "notify",
          reasonSummary: "Important direct reply from support.",
          verificationBehavior: "verified",
        },
      },
    }
  )

  expect(create.status()).toBe(201)
  const created = await create.json()
  expect(created).toMatchObject({ status: "succeeded" })

  const detailResponse = await page.request.get("/api/runs/" + created.runId)
  expect(detailResponse.ok()).toBe(true)
  const detail = await detailResponse.json()
  expect(detail).toMatchObject({
    mode: "test",
    route: "notify",
    reasonSummary: "Important direct reply from support.",
    verification: "verified",
    execution: "succeeded",
  })
  expect(detail.nodeExecutions).toHaveLength(4)
  expect(detail.modelInvocations).toHaveLength(1)
  expect(detail.actionExecutions).toHaveLength(1)
  expect(detail.actionExecutions[0]).toMatchObject({
    integrationKey: "telegram",
    actionKey: "send-message",
  })

  const overview = await page.request.get("/api/overview")
  expect(await overview.json()).toMatchObject({
    runs24h: 0,
    cost24hUsd: 0,
  })

  await page.goto("/runs")
  const row = page.getByRole("button").filter({
    hasText: "Playwright fake runtime reply",
  })
  await expect(row).toBeVisible()
  await expect(row.getByText("TEST", { exact: true })).toBeVisible()
  await expect(row.getByText("notify", { exact: true }).last()).toBeVisible()
  await row.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByText("Important direct reply from support.", { exact: true })
  ).toBeVisible()
  await expect(dialog.getByText("verified", { exact: true })).toBeVisible()
})

test("connection shells are visible but not falsely connected", async ({
  page,
}) => {
  await page.goto("/connections")
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible()
  await expect(page.getByText("Primary Google", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Atlas Telegram bot", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("google", { exact: true })).toBeVisible()
  await expect(page.getByText("telegram", { exact: true })).toBeVisible()
  await expect(page.getByText("disabled", { exact: true })).toHaveCount(2)
})

test("mobile pages keep document layout inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })

  for (const path of [
    "/",
    "/automations",
    "/runs",
    "/connections",
    "/automations/email-triage",
  ]) {
    await page.goto(path)
    await page.waitForTimeout(250)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    )
    expect(
      overflow,
      path + " should not cause document-level horizontal overflow"
    ).toBe(false)
  }

  await page.goto("/automations/email-triage")
  await page.locator(".react-flow__node").filter({ hasText: "Notify" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(
    page.getByRole("dialog").getByText("neutral", { exact: true })
  ).toBeVisible()
})

test("trusted code steps show graph, sequential full I/O, source and empty-result behavior", async ({
  page,
}) => {
  await page.goto("/automations")
  await page
    .locator("tbody")
    .getByRole("link")
    .filter({ hasText: "Email Code Steps" })
    .click()
  await expect(
    page.getByText("Automations / Email Code Steps", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Email Code Steps" })
  ).toBeVisible()
  await expect(page.locator(".react-flow__node")).toHaveCount(3)
  await expect(
    page
      .locator(".react-flow__node")
      .getByText("no executions", { exact: true })
  ).toHaveCount(3)
  await expect(
    page.locator(".react-flow__node").filter({ hasText: "transform" })
  ).toHaveCount(3)
  const inspect = await page.request.get(
    "/api/code-automations/email-summary/versions/1"
  )
  expect(inspect.status()).toBe(200)
  const metadata = await inspect.json()
  expect(metadata.graph.entryNodeKey).toBe("normalize")
  await page.screenshot({
    path: `${verificationEvidenceDirectory("browser")}/code-steps-graph.png`,
    fullPage: true,
  })
  await page.getByRole("button", { name: "Run fake email fixture" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Execution log", { exact: true })).toBeVisible()
  await expect(dialog.getByTestId("step-execution")).toHaveCount(3)
  const step = dialog.getByTestId("step-execution").nth(2)
  await step.locator("summary").first().click()
  await expect(step.getByText("Step input", { exact: true })).toBeVisible()
  await expect(step.getByText("Step output", { exact: true })).toBeVisible()
  await expect(step.getByText("Step error", { exact: true })).toBeVisible()
  await step.getByText("Callable source", { exact: true }).click()
  await expect(step.locator("pre").last()).toContainText("reduce")
  await page.screenshot({
    path: `${verificationEvidenceDirectory("browser")}/code-steps-run-detail.png`,
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  // A second run remains usable after closing the first inspector.
  await page.getByRole("button", { name: "Run fake email fixture" }).click()
  await expect(dialog.getByTestId("step-execution")).toHaveCount(3)
  await page.keyboard.press("Escape")
  for (const input of [
    [],
    metadata.fixture.filter((email: { read: boolean }) => !email.read),
  ]) {
    const created = await page.request.post(
      "/api/code-automations/email-summary/test-runs",
      { data: { version: 1, input } }
    )
    expect(created.status()).toBe(201)
    const result = await created.json()
    expect(result.output).toEqual({ count: 0, ids: [], bySender: [] })
    const response = await page.request.get(`/api/runs/${result.runId}`)
    const detail = await response.json()
    expect(detail.nodeExecutions).toHaveLength(3)
    expect(detail.nodeExecutions[1].input).toEqual(
      detail.nodeExecutions[0].output
    )
    expect(detail.nodeExecutions[2].input).toEqual(
      detail.nodeExecutions[1].output
    )
    expect(detail.nodeExecutions[2].implementation).toEqual(
      metadata.graph.nodes[2].config.implementation
    )
    expect(detail.actionExecutions).toHaveLength(0)
    expect(detail.modelInvocations).toHaveLength(0)
  }
})

test("code-step failure stops downstream and JSON is displayed as inert text", async ({
  page,
}) => {
  const payload = '<img src=x onerror="window.atlasInjected=true">'
  const response = await page.request.post(
    "/api/code-automations/email-summary/test-runs",
    {
      data: {
        version: 1,
        input: [
          {
            id: "xss",
            sender: "   ",
            subject: payload,
            read: true,
            starred: false,
            category: "newsletter",
          },
        ],
      },
    }
  )
  expect(response.status()).toBe(201)
  const failed = await response.json()
  expect(failed.status).toBe("failed")
  const detail = await (
    await page.request.get(`/api/runs/${failed.runId}`)
  ).json()
  expect(detail.nodeExecutions).toHaveLength(1)
  expect(detail.error.code).toBe("invalid_step_output")
  await page.goto("/runs")
  await page
    .getByText(`Run ${failed.runId.slice(0, 8)}`, { exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("pre").first()).toContainText("atlasInjected")
  expect(
    JSON.parse((await dialog.locator("pre").first().textContent())!)[0].subject
  ).toBe(payload)
  expect(
    await page.evaluate(
      () => (window as Window & { atlasInjected?: boolean }).atlasInjected
    )
  ).toBeUndefined()
  expect(await dialog.locator("img").count()).toBe(0)
  await dialog.getByTestId("step-execution").locator("summary").first().click()
  await expect(dialog.getByText("Step error", { exact: true })).toBeVisible()
})
