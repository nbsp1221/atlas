import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) =>
    route.fulfill({ status: 404, json: { error: "unmocked_test_route" } })
  )
})

const connection = {
  id: "fake-key-1",
  key: "fake-openai",
  label: "Personal OpenAI",
  providerKey: "openai",
  status: "active",
  authState: "unchecked",
  principalId: null,
  principalType: null,
  grantedScopes: [],
  lastCheckedAt: null,
  usageCount: 2,
  hasSecret: true,
  revision: 3,
  lastErrorCode: null,
}
const settings = {
  connections: [connection],
  oauthClients: [],
  credentialStorageAvailable: true,
  callbackUrl:
    "https://atlas.example.test/api/settings/connections/google/callback",
}
async function mock(page: Page, data = settings) {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: { session: { id: "fake" }, user: { id: "fake-owner" } },
    })
  )
  await page.route("**/api/settings/connections", (route) =>
    route.fulfill({ json: data })
  )
  await page.route("**/api/automations", (route) => route.fulfill({ json: [] }))
}

test("metadata is truthful and secret forms clear on failure and cancellation", async ({
  page,
}) => {
  await mock(page)
  const requests: unknown[] = []
  await page.route("**/api/settings/connections/api-key", async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({
      status: 403,
      json: { error: "reauthentication_required", secret: "must-not-render" },
    })
  })
  await page.goto("/connections")
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Not yet verified", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Not verified", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Add API key", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Connection label").fill("Fixture key")
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("fake-secret-for-ui-only")
  await dialog
    .getByRole("button", { name: "Save API key", exact: true })
    .click()
  await expect(dialog.getByRole("alert")).toHaveText(
    "Sign in again before changing credentials."
  )
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("")
  expect(requests).toEqual([
    {
      providerKey: "openai",
      label: "Fixture key",
      secret: "fake-secret-for-ui-only",
    },
  ])
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      })
    )
  ).not.toContain("fake-secret-for-ui-only")
  await expect(page.getByText("must-not-render")).toHaveCount(0)
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("cancelled-fake-secret")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Add API key", exact: true }).click()
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("")
  await dialog.getByLabel("Provider", { exact: true }).selectOption("telegram")
  await expect(dialog.getByLabel("Telegram bot token")).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
})

test("destructive actions explain scope and send explicit revision only after confirmation", async ({
  page,
}) => {
  await mock(page)
  const requests: unknown[] = []
  await page.route(
    "**/api/settings/connections/fake-key-1/disconnect",
    async (route) => {
      requests.push(route.request().postDataJSON())
      await route.fulfill({
        json: {
          connection: { ...connection, status: "disabled", revision: 4 },
        },
      })
    }
  )
  await page.goto("/connections")
  await page
    .getByRole("button", { name: "Disable locally", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("remains valid at the provider")
  expect(requests).toHaveLength(0)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(requests).toHaveLength(0)
  await page
    .getByRole("button", { name: "Disable locally", exact: true })
    .click()
  await dialog
    .getByRole("button", { name: "Confirm disable locally", exact: true })
    .click()
  await expect(dialog).toBeHidden()
  expect(requests).toEqual([{ revision: 3 }])
})

test("empty, unavailable storage, load errors and mobile layout stay usable", async ({
  page,
}) => {
  await mock(page, {
    ...settings,
    connections: [],
    credentialStorageAvailable: false,
  })
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto("/connections")
  await expect(
    page.getByText("No connections yet.", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Add API key", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Configure Google client" })
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1
    )
  ).toBe(false)
  await page.route("**/api/settings/connections", (route) =>
    route.fulfill({
      status: 500,
      json: { error: "internal", detail: "never-render-server-detail" },
    })
  )
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Retry loading" })
  ).toBeVisible()
  await expect(page.getByText("never-render-server-detail")).toHaveCount(0)
})

test("Google client configuration stays separate and secrets are never returned", async ({
  page,
}) => {
  await mock(page)
  let submitted: unknown
  await page.route("**/api/settings/oauth-clients/google", async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({
      json: {
        providerKey: "google",
        clientId: "fake-client",
        hasSecret: true,
        revision: 1,
      },
    })
  })
  await page.goto("/connections")
  await expect(
    page.getByRole("button", { name: "Connect Google account", exact: true })
  ).toBeDisabled()
  await page.getByRole("button", { name: "Configure Google client" }).click()
  const dialog = page.getByRole("dialog")
  await dialog
    .getByLabel("Google client ID", { exact: true })
    .fill("fake-client")
  await dialog
    .getByLabel("Google client secret", { exact: true })
    .fill("fake-google-secret")
  await dialog.getByRole("button", { name: "Save OAuth client" }).click()
  await expect(dialog).toBeHidden()
  expect(submitted).toEqual({
    clientId: "fake-client",
    clientSecret: "fake-google-secret",
  })
  expect(await page.content()).not.toContain("fake-google-secret")
})

test("app gate fails closed and clears failed sign-in password", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ status: 503, json: { error: "auth_not_configured" } })
  )
  await page.goto("/connections")
  await expect(
    page.getByText("Deployment setup is pending.", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true })
  ).toHaveCount(0)
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } })
  )
  await page.route("**/api/auth/sign-in/email", (route) =>
    route.fulfill({
      status: 401,
      json: { error: "fake-secret-must-not-appear" },
    })
  )
  await page.getByRole("button", { name: "Retry session check" }).click()
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test")
  await page
    .getByLabel("Password", { exact: true })
    .fill("fake-signin-password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in failed. Check your details and try again."
  )
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("")
})

test("pending saves block repeated submit and dismissal", async ({ page }) => {
  await mock(page)
  let count = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/settings/connections/api-key", async (route) => {
    count++
    await gate
    await route.fulfill({ json: { connection } })
  })
  await page.goto("/connections")
  await page.getByRole("button", { name: "Add API key", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Connection label").fill("Fake test")
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("fake-pending-secret")
  await dialog
    .getByRole("button", { name: "Save API key", exact: true })
    .click()
  await expect(
    dialog.getByRole("button", { name: "Working…", exact: true })
  ).toBeDisabled()
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true })
  ).toBeDisabled()
  expect(count).toBe(1)
  release()
  await expect(dialog).toBeHidden()
  expect(count).toBe(1)
})

test("Google reconnect keeps record identity and rejects unsafe authorization destinations", async ({
  page,
}) => {
  await mock(page)
  await page.route("**/api/settings/connections", (route) =>
    route.fulfill({
      json: {
        ...settings,
        connections: [
          {
            ...connection,
            providerKey: "google",
            label: "Work Google",
            authState: "reauth_required",
          },
        ],
        oauthClients: [
          {
            providerKey: "google",
            clientId: "fake-client",
            hasSecret: true,
            revision: 2,
          },
        ],
      },
    })
  )
  let submitted: unknown
  await page.route(
    "**/api/settings/connections/google/authorize",
    async (route) => {
      submitted = route.request().postDataJSON()
      await route.fulfill({
        json: { authorizationUrl: "https://unsafe.example.test/steal" },
      })
    }
  )
  await page.goto("/connections")
  await page
    .getByRole("button", { name: "Reconnect account", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Connection label")).toHaveCount(0)
  await dialog
    .getByRole("button", { name: "Continue to Google", exact: true })
    .click()
  await expect(dialog.getByRole("alert")).toHaveText(
    "The server returned an invalid authorization destination."
  )
  expect(submitted).toEqual({ connectionId: connection.id, revision: 3 })
  await expect(page).toHaveURL(/\/connections$/)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page
    .getByRole("button", { name: "Revoke Google grant", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toContainText(
    "including grants outside Atlas"
  )
})

test("revocation failure is never presented as successful provider revocation", async ({
  page,
}) => {
  await mock(page)
  await page.route("**/api/settings/connections", (route) =>
    route.fulfill({
      json: {
        ...settings,
        connections: [{ ...connection, providerKey: "google" }],
      },
    })
  )
  await page.route("**/api/settings/connections/fake-key-1/revoke", (route) =>
    route.fulfill({
      json: {
        connection: {
          ...connection,
          providerKey: "google",
          status: "disabled",
          lastErrorCode: "revocation_failed",
        },
      },
    })
  )
  await page.goto("/connections")
  await page
    .getByRole("button", { name: "Revoke Google grant", exact: true })
    .click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm revoke google grant", exact: true })
    .click()
  await expect(page.getByRole("status")).toContainText(
    "Google revocation could not be confirmed"
  )
})

test("resume is offered only for disabled verified credentials and requires confirmation", async ({
  page,
}) => {
  await mock(page)
  const ready = { ...connection, status: "disabled", authState: "ready" }
  await page.route("**/api/settings/connections", (route) =>
    route.fulfill({
      json: {
        ...settings,
        connections: [
          ready,
          {
            ...connection,
            id: "unverified",
            status: "disabled",
            label: "Unverified credential",
          },
          {
            ...ready,
            id: "missing",
            hasSecret: false,
            authState: "missing",
            label: "Missing credential",
          },
        ],
      },
    })
  )
  const requests: unknown[] = []
  await page.route("**/api/settings/connections/fake-key-1/resume", (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({
      json: { connection: { ...ready, status: "active", revision: 4 } },
    })
  })
  await page.goto("/connections")
  await expect(
    page.getByRole("button", { name: "Resume locally", exact: true })
  ).toHaveCount(1)
  await page
    .getByRole("button", { name: "Resume locally", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Restore local use")
  expect(requests).toHaveLength(0)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(requests).toHaveLength(0)
  await page
    .getByRole("button", { name: "Resume locally", exact: true })
    .click()
  await dialog
    .getByRole("button", { name: "Confirm resume locally", exact: true })
    .click()
  await expect(dialog).toBeHidden()
  expect(requests).toEqual([{ revision: 3 }])
})

const mailboxId = "11111111-1111-4111-8111-111111111111"
const modelId = "22222222-2222-4222-8222-222222222222"
const bindingFixture = {
  version: 1,
  mailboxConnectionId: mailboxId,
  modelConnectionId: null as string | null,
  model: "email-triage-classifier-v1",
  connections: [
    {
      id: mailboxId,
      key: "google-primary",
      label: "Work mailbox",
      providerKey: "google",
      status: "disabled",
      authState: "unchecked",
    },
    {
      id: modelId,
      key: "openai-primary",
      label: "Model provider",
      providerKey: "openai",
      status: "active",
      authState: "ready",
    },
    {
      id: "archived",
      key: "old-google",
      label: "Archived mailbox",
      providerKey: "google",
      status: "archived",
      authState: "missing",
    },
    {
      id: "telegram",
      key: "bot",
      label: "Notification bot",
      providerKey: "telegram",
      status: "active",
      authState: "ready",
    },
  ],
}
function automationFixture(version = 1, id = "email-triage") {
  return {
    id,
    name: "Email Triage",
    description: "Fake fixture",
    version,
    versionCreatedAt: "2026-10-01T00:00:00Z",
    definitionHash: "fixture-hash",
    model: "fake",
    verifiedRate: null,
    cost24hUsd: 0,
    runs24h: 0,
    status: "paused",
    graph: {
      automationId: id,
      version,
      nodes: [
        {
          id: "classify_email",
          key: "classify_email",
          label: "Classify email",
          kind: "decision",
          executions: 0,
          health: "neutral",
        },
      ],
      edges: [],
    },
  }
}

test("Email Triage binding picker filters providers and saves a new version without execution", async ({
  page,
}) => {
  await mock(page)
  let version = 1
  const mutations: unknown[] = []
  await page.route("**/api/automations/email-triage", (route) =>
    route.fulfill({ json: automationFixture(version) })
  )
  await page.route(
    "**/api/settings/automations/email-triage/connections",
    async (route) => {
      if (route.request().method() === "POST") {
        mutations.push(route.request().postDataJSON())
        version = 2
        await route.fulfill({ json: { version } })
      } else await route.fulfill({ json: { ...bindingFixture, version } })
    }
  )
  await page.goto("/automations/email-triage")
  await page
    .getByRole("button", { name: "Connection bindings", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Email Triage connections" })
  await expect(dialog).toContainText(
    "Existing simulation stays fake and makes no provider calls"
  )
  await expect(
    dialog.getByLabel("Google mailbox connection").locator("option")
  ).toHaveCount(2)
  await expect(
    dialog.getByLabel("Model connection").locator("option")
  ).toHaveCount(2)
  await expect(dialog.getByLabel("Model name", { exact: true })).toHaveCount(0)
  await dialog.getByLabel("Model connection").selectOption(modelId)
  await expect(
    dialog.getByRole("button", { name: "Save as new version" })
  ).toBeDisabled()
  await dialog
    .getByLabel("Model name", { exact: true })
    .fill("fake-provider-model-for-test")
  await expect(dialog).toContainText(
    "Saving a binding does not enable or verify credentials"
  )
  await dialog.getByRole("button", { name: "Save as new version" }).click()
  await expect(dialog).toBeHidden()
  expect(mutations).toEqual([
    {
      expectedVersion: 1,
      mailboxConnectionId: mailboxId,
      modelConnectionId: modelId,
      model: "fake-provider-model-for-test",
    },
  ])
  await expect(page.getByRole("status")).toContainText(
    "Saved connection bindings as v2"
  )
  await expect(page.getByText("v2 · 0 runs", { exact: false })).toBeVisible()
})

test("binding conflicts are safe, cancellation resets edits, and other automations omit the picker", async ({
  page,
}) => {
  await mock(page)
  let requests = 0
  await page.route("**/api/automations/email-triage", (route) =>
    route.fulfill({ json: automationFixture() })
  )
  await page.route("**/api/automations/email-summary", (route) =>
    route.fulfill({ json: automationFixture(1, "email-summary") })
  )
  await page.route(
    "**/api/settings/automations/email-triage/connections",
    async (route) => {
      if (route.request().method() === "POST") {
        requests++
        await route.fulfill({
          status: 409,
          json: { error: "version_conflict", detail: "unsafe-detail" },
        })
      } else await route.fulfill({ json: bindingFixture })
    }
  )
  await page.goto("/automations/email-triage")
  await page
    .getByRole("button", { name: "Connection bindings", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Email Triage connections" })
  await dialog.getByLabel("Model connection").selectOption(modelId)
  await dialog.getByLabel("Model name", { exact: true }).fill("discarded-model")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  expect(requests).toBe(0)
  await page
    .getByRole("button", { name: "Connection bindings", exact: true })
    .click()
  await expect(dialog.getByLabel("Model connection")).toHaveValue("")
  await dialog.getByRole("button", { name: "Save as new version" }).click()
  await expect(dialog.getByRole("alert")).toContainText(
    "Reload bindings and review your selection"
  )
  await expect(dialog.getByText("unsafe-detail")).toHaveCount(0)
  expect(requests).toBe(1)
  await dialog.getByRole("button", { name: "Reload bindings" }).click()
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.goto("/automations/email-summary")
  await expect(
    page.getByRole("heading", { name: "Email Triage", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Connection bindings", exact: true })
  ).toHaveCount(0)
})

test("run inspector shows historical model connection identity without claiming a live provider call", async ({
  page,
}) => {
  await mock(page)
  const occurredAt = "2026-10-01T00:00:00Z"
  const row = {
    id: "fake-evidence-run",
    automationId: "email-triage",
    automationName: "Email Triage",
    occurredAt,
    sender: "Fixture",
    subject: "Historical binding evidence",
    route: "no_action",
    model: "fixture-model",
    latencyMs: 1,
    verification: "verified",
    mode: "test",
  }
  const invocation = {
    id: "model-evidence",
    nodeExecutionId: "node-evidence",
    sequence: 1,
    status: "succeeded",
    modelProvider: "openai",
    model: "fixture-model",
    modelParameters: {},
    providerRequestId: "fake-model-1",
    input: {},
    output: {},
    error: null,
    usageDetails: {},
    costDetails: {},
    costUsd: 0,
    durationMs: 1,
    startedAt: occurredAt,
    finishedAt: occurredAt,
  }
  const detail = {
    ...row,
    status: "succeeded",
    automationVersion: 1,
    senderEmail: "fixture@example.test",
    body: "Fixture body",
    prompt: "Fixture prompt",
    reasonSummary: "Fixture",
    usageDetails: {},
    costUsd: 0,
    action: "none",
    execution: "succeeded",
    evidence: "Fake evidence",
    input: {},
    output: {},
    error: null,
    definitionHash: "fixture-hash",
    nodeExecutions: [
      {
        id: "node-evidence",
        sequence: 1,
        nodeKey: "classify_email",
        nodeKind: "decision",
        status: "succeeded",
        retryOfNodeExecutionId: null,
        selectedEdgeKey: "no_action",
        input: {},
        output: {},
        error: null,
        startedAt: occurredAt,
        finishedAt: occurredAt,
        implementation: null,
      },
    ],
    modelInvocations: [
      { ...invocation, connectionId: modelId },
      {
        ...invocation,
        id: "legacy-model",
        sequence: 2,
        modelProvider: "testkit",
        connectionId: null,
      },
    ],
    actionExecutions: [],
    feedback: [],
  }
  await page.route("**/api/runs", (route) => route.fulfill({ json: [row] }))
  await page.route("**/api/runs/fake-evidence-run", (route) =>
    route.fulfill({ json: detail })
  )
  await page.goto("/runs")
  await page
    .getByRole("button")
    .filter({ hasText: "Historical binding evidence" })
    .click()
  const dialog = page.getByRole("dialog")
  await dialog.getByTestId("step-execution").locator("summary").first().click()
  const models = dialog.getByTestId("model-invocation")
  await models.nth(0).locator("summary").first().click()
  await expect(
    models.nth(0).getByTestId("model-connection-evidence")
  ).toHaveText(`Configured connection ID: ${modelId}`)
  await models.nth(1).locator("summary").first().click()
  await expect(
    models.nth(1).getByTestId("model-connection-evidence")
  ).toContainText("Not recorded (fake or legacy invocation)")
})
