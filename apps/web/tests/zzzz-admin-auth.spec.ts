import { expect, test } from "@playwright/test"

test.use({ storageState: { cookies: [], origins: [] } })

test("native HTTPS login, encrypted Settings, logout and password rotation work without API mocks", async ({
  page,
}) => {
  const password = process.env.ATLAS_TEST_OWNER_PASSWORD
  if (!password) throw new Error("Isolated owner password required")
  expect((await page.request.get("/api/settings/connections")).status()).toBe(
    401
  )
  await page.goto("/connections")
  await expect(
    page.getByRole("heading", { name: "Sign in to Atlas" })
  ).toBeVisible()
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test")
  await page.getByLabel("Password", { exact: true }).fill(password)
  const login = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/sign-in/email")
  )
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  expect(await (await login).json()).toEqual({ success: true })
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true })
  ).toBeVisible()
  const cookies = await page.context().cookies()
  const session = cookies.find((cookie) =>
    cookie.name.endsWith("session_token")
  )
  expect(session).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  })
  expect(session?.domain).toBe("localhost")
  await page.getByRole("button", { name: "Add API key", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Connection label").fill("HTTPS fixture model")
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("synthetic-browser-key-only")
  await dialog
    .getByRole("button", { name: "Save API key", exact: true })
    .click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole("heading", { name: "HTTPS fixture model", exact: true })
  ).toBeVisible()
  const metadata = await page.request.get("/api/settings/connections")
  expect(await metadata.text()).not.toContain("synthetic-browser-key-only")
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      })
    )
  ).not.toContain("synthetic-browser-key-only")
  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Sign in to Atlas" })
  ).toBeVisible()
  expect((await page.request.get("/api/overview")).status()).toBe(401)
  await expect(page.getByText("HTTPS fixture model")).toHaveCount(0)
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test")
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click()
  await page.getByLabel("Current password", { exact: true }).fill(password)
  await page
    .getByLabel("New password", { exact: true })
    .fill("synthetic-browser-new-password-only")
  await page.getByRole("button", { name: "Save password", exact: true }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Password changed" })
  ).toBeVisible()
  expect((await page.request.get("/api/overview")).status()).toBe(200)
  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Sign in to Atlas" })
  ).toBeVisible()
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test")
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-browser-new-password-only")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true })
  ).toBeVisible()
})
