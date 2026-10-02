import { expect, test } from "@playwright/test"

test("Atlas identity is visible in the browser and navigation", async ({
  page,
}) => {
  await page.goto("/")
  await expect(page).toHaveTitle("Atlas")
  await expect(page.locator("header")).toContainText("Atlas /")
  await expect(page.locator('[data-sidebar="header"]')).toContainText("Atlas")
  await expect(page.getByText("Control Plane", { exact: true })).toHaveCount(0)

  const icon = page.locator('link[rel="icon"]')
  await expect(icon).toHaveAttribute("href", "/favicon.svg")
  const response = await page.request.get("/favicon.svg")
  expect(response.ok()).toBe(true)
  expect(response.headers()["content-type"]).toContain("image/svg+xml")
  expect(await response.text()).toContain('viewBox="0 0 32 32"')
})
