import { defineConfig } from "@playwright/test"

// UI-only suite: every /api request is intercepted in connections-settings.spec.ts.
// No database, authentication bypass, provider access, or existing server reuse.
export default defineConfig({
  testDir: "./tests",
  testMatch: "connections-settings.spec.ts",
  workers: 1,
  timeout: 20_000,
  outputDir: "test-results/connections-mocked",
  use: {
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    baseURL: "http://127.0.0.1:44283",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 44283 --strictPort",
    url: "http://127.0.0.1:44283",
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
