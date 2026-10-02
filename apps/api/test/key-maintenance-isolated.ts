import { verificationDatabaseUrl } from "../../../scripts/verification-isolation.mjs"
import { randomBytes, randomUUID } from "node:crypto"
import { createDatabase, createConnectionRepository } from "@workspace/db"
import { CredentialCrypto } from "../src/connections/crypto"
import { verifyKeyMaintenance } from "./connections-key-maintenance-verification"
const runId = process.env.VERIFICATION_RUN_ID
if (
  !runId ||
  !/^[a-f0-9]{24}$/.test(runId) ||
  process.env.DATABASE_URL !==
    verificationDatabaseUrl("runtime", runId)
)
  throw new Error("Refusing non-isolated key maintenance database")
const { db, client } = createDatabase(process.env.DATABASE_URL)
const unitKey = randomBytes(32).toString("base64")
const crypto = new CredentialCrypto("unit", { unit: unitKey })
const repo = createConnectionRepository(db)
try {
  for (let i = 0; i < 3; i++) {
    const id = randomUUID()
    await repo.create({
      id: randomUUID(),
      providerKey: "openai",
      label: "Isolated fixture",
      secret: {
        id,
        providerKey: "openai",
        authType: "api_key",
        envelope: crypto.encrypt(
          { key: "synthetic-fixture-value" },
          { id, provider: "openai", authType: "api_key" }
        ),
      },
    })
  }
  const id = randomUUID()
  await repo.saveGoogleClient("fixture.apps.googleusercontent.com", {
    id,
    providerKey: "google",
    authType: "oauth_client",
    envelope: crypto.encrypt(
      { key: "synthetic-client-fixture" },
      { id, provider: "google", authType: "oauth_client" }
    ),
  })
  await verifyKeyMaintenance(db, crypto, unitKey)
} finally {
  await client.end()
}
