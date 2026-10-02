import { request } from "@playwright/test"
import { verificationServerConfig } from "../../../scripts/verification-isolation.mjs"

export default async function setup() {
  const config = verificationServerConfig(process.env)
  if (
    !process.env.ATLAS_TEST_OWNER_PASSWORD ||
    !process.env.ATLAS_TEST_STORAGE_STATE ||
    !config.webUrl.startsWith("https:")
  )
    throw new Error("Isolated HTTPS auth fixtures required")
  const context = await request.newContext({
    baseURL: config.webUrl,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { origin: config.webUrl },
  })
  try {
    const response = await context.post("/api/auth/sign-in/email", {
      data: {
        email: "owner@example.test",
        password: process.env.ATLAS_TEST_OWNER_PASSWORD,
      },
    })
    if (!response.ok()) throw new Error("Verification owner sign-in failed")
    await context.storageState({ path: process.env.ATLAS_TEST_STORAGE_STATE })
  } finally {
    await context.dispose()
  }
}
