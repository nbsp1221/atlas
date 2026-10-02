import { defineConfig } from "@playwright/test"
import {
  verificationServerConfig,
  verificationWebServers,
} from "../../scripts/verification-isolation.mjs"

const config = verificationServerConfig(process.env)

export default defineConfig({
  testDir: "./tests",
  outputDir:
    "../../audit/admin-auth/verification/" +
    process.env.VERIFICATION_RUN_ID +
    "/playwright-results",
  timeout: 20_000,
  // Match the serialized full gate to the supported 2 GiB sandbox budget.
  workers: 1,
  globalSetup: "./tests/admin-auth-setup.ts",
  use: {
    baseURL: config.webUrl,
    ignoreHTTPSErrors: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    storageState: process.env.ATLAS_TEST_STORAGE_STATE,
    extraHTTPHeaders: { origin: config.webUrl },
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  webServer: verificationWebServers(process.env),
})
