import { verificationEvidenceDirectory } from "../../../scripts/verification-isolation.mjs"
import { expect, test, type Page } from "@playwright/test"

const menu = (page: Page) => page.locator('[data-sidebar="menu-button"]')

async function expectCurrent(page: Page, label: string) {
  const selected = page.locator(
    '[data-sidebar="menu-button"][aria-current="page"]'
  )
  await expect(selected).toHaveCount(1)
  await expect(selected).toHaveText(label)
  await expect(
    page.locator('[data-sidebar="menu-button"][data-active]')
  ).toHaveCount(1)
  await expect(selected).toHaveAttribute("data-active", "")
  await expect(selected).toHaveCSS("font-weight", "600")
  return selected
}

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1")
  await page.getByRole("dialog").evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished))
  })
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} sidebar`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((theme) => {
        localStorage.setItem("control-plane-theme", theme)
      }, theme)
    })
    test("mobile navigation has one clear current page and closes on selection", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto("/automations/email-summary?view=graph")
      await expect(
        page.getByRole("heading", { name: "Email Code Steps" })
      ).toBeVisible()
      await openMenu(page)
      const selected = await expectCurrent(page, "Email Code Steps")
      await expect(
        menu(page).filter({ hasText: /^Automations$/ })
      ).not.toHaveAttribute("aria-current")
      const color = await selected.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      )
      await selected.hover()
      await expect(selected).toHaveCSS("background-color", color)
      await page.screenshot({
        path: `${verificationEvidenceDirectory("sidebar")}/mobile-${theme}.png`,
      })

      // Same-page links also dismiss the drawer.
      await selected.click()
      await expect(page.getByRole("dialog")).toBeHidden()
      for (const [label, path] of [
        ["Runs", "/runs"],
        ["Connections", "/connections"],
        ["Automations", "/automations"],
        ["Email Triage", "/automations/email-triage"],
        ["Overview", "/"],
      ]) {
        await openMenu(page)
        await menu(page)
          .filter({ hasText: new RegExp(`^${label}$`) })
          .click()
        await expect(page).toHaveURL(new RegExp(`${path}$`))
        await expect(page.getByRole("dialog")).toBeHidden()
        await openMenu(page)
        await expectCurrent(page, label)
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).toBeHidden()
        await expect(
          page.getByRole("button", { name: "Toggle Sidebar" })
        ).toBeFocused()
      }
    })

    test("mobile Back/Forward, trailing slash, and keyboard focus stay in sync", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 740 })
      await page.goto("/automations/email-summary/?view=runs#latest")
      await openMenu(page)
      await expectCurrent(page, "Email Code Steps")
      await menu(page)
        .filter({ hasText: /^Runs$/ })
        .click()
      await expect(page.getByRole("dialog")).toBeHidden()
      await openMenu(page)
      await page.goBack()
      await expect(page.getByRole("dialog")).toBeHidden()
      await openMenu(page)
      await expectCurrent(page, "Email Code Steps")
      await page.goForward()
      await expect(page.getByRole("dialog")).toBeHidden()
      await openMenu(page)
      const selected = await expectCurrent(page, "Runs")
      await page.keyboard.press("Tab")
      await selected.focus()
      await expect(selected).toBeFocused()
      expect(
        await selected.evaluate((el) => getComputedStyle(el).boxShadow)
      ).not.toBe("none")
      await page.screenshot({
        path: `${verificationEvidenceDirectory("sidebar")}/mobile-keyboard-${theme}.png`,
      })
      await page.keyboard.press("Enter")
      await expect(page.getByRole("dialog")).toBeHidden()
      await page.getByRole("button", { name: "Toggle Sidebar" }).focus()
      await page.keyboard.press("Enter")
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(
        page.getByRole("button", { name: "Toggle Sidebar" })
      ).toBeFocused()
    })

    test("desktop and icon-only navigation keep visible accessible active styling", async ({
      page,
    }) => {
      await page.goto("/automations/email-summary")
      const selected = await expectCurrent(page, "Email Code Steps")
      await expect(selected).toHaveCSS(
        "background-color",
        await selected.evaluate((el) => {
          // Resolve the token through the browser; percentages and decimal
          // OKLCH values can serialize differently while meaning the same color.
          const probe = document.createElement("span")
          probe.style.color =
            getComputedStyle(el).getPropertyValue("--sidebar-accent")
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        })
      )
      await expect(selected).toHaveCSS(
        "color",
        await selected.evaluate((el) => {
          // Resolve the token through the browser; percentages and decimal
          // OKLCH values can serialize differently while meaning the same color.
          const probe = document.createElement("span")
          probe.style.color = getComputedStyle(el).getPropertyValue(
            "--sidebar-accent-foreground"
          )
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        })
      )
      const style = await selected.evaluate((el) => {
        const css = getComputedStyle(el)
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const context = canvas.getContext("2d")!
        function luminance(color: string) {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const rgb = [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((n) => {
              const value = n / 255
              return value <= 0.04045
                ? value / 12.92
                : ((value + 0.055) / 1.055) ** 2.4
            })
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        }
        const foreground = luminance(css.color)
        const background = luminance(css.backgroundColor)
        return {
          contrast:
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05),
          marker: getComputedStyle(el, "::before").width,
        }
      })
      console.log(
        `${theme} selected-text contrast: ${style.contrast.toFixed(2)}:1`
      )
      expect(style.contrast).toBeGreaterThanOrEqual(4.5)
      expect(style.marker).toBe("2px")
      await page.screenshot({
        path: `${verificationEvidenceDirectory("sidebar")}/desktop-${theme}.png`,
      })
      await page.keyboard.press("Control+b")
      await expectCurrent(page, "Email Code Steps")
      await expect(selected).toHaveCSS("width", "32px")
      await page.screenshot({
        path: `${verificationEvidenceDirectory("sidebar")}/desktop-collapsed-${theme}.png`,
      })
      await page.keyboard.press("Control+b")
      await menu(page)
        .filter({ hasText: /^Automations$/ })
        .click()
      await expectCurrent(page, "Automations")
      await page.goBack()
      await expectCurrent(page, "Email Code Steps")
    })
  })
}
