import { createDatabase } from "@workspace/db"
import { provisionOwner } from "../src/auth/provision-owner"
import { verificationDatabaseUrl } from "../../../scripts/verification-isolation.mjs"

const runId = process.env.VERIFICATION_RUN_ID
if (
  !runId ||
  process.env.DATABASE_URL !== verificationDatabaseUrl("e2e", runId) ||
  !process.env.ATLAS_TEST_OWNER_PASSWORD
)
  throw new Error("Refusing non-isolated owner fixture")
const { db, client } = createDatabase(process.env.DATABASE_URL)
try {
  await provisionOwner(db, {
    email: "owner@example.test",
    name: "Verification owner",
    password: process.env.ATLAS_TEST_OWNER_PASSWORD,
  })
} finally {
  await client.end()
}
