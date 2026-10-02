import { eq, sql } from "drizzle-orm"
import { credentialSecrets, oauthAttempts, type Database } from "@workspace/db"
import { CredentialCrypto, credentialCryptoFromEnv } from "./crypto"

export type KeyInventory = {
  credentials: number
  attempts: number
  keyVersions: Record<string, number>
}
const contextOf = (row: typeof credentialSecrets.$inferSelect) => ({
  id: row.id,
  provider: row.providerKey,
  authType: row.authType,
})
const attemptContext = (row: typeof oauthAttempts.$inferSelect) => ({
  id: row.stateHash,
  provider: "google",
  authType: "oauth_verifier",
})

// Call and await before registering credential routes, live resolvers, or listening.
// A consistent read-only snapshot authenticates every envelope, not merely one sample.
export async function validateCredentialStorage(
  db: Database,
  crypto: CredentialCrypto | null
): Promise<KeyInventory> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`set transaction isolation level repeatable read read only`
      )
      const rows = await tx.select().from(credentialSecrets)
      const attempts = await tx.select().from(oauthAttempts)
      const inventory: KeyInventory = {
        credentials: rows.length,
        attempts: attempts.length,
        keyVersions: Object.create(null) as Record<string, number>,
      }
      const check = (
        envelope: (typeof credentialSecrets.$inferSelect)["envelope"],
        context: ReturnType<typeof contextOf>
      ) => {
        if (!crypto) throw new Error()
        crypto.decrypt(envelope, context)
        inventory.keyVersions[envelope.keyVersion] =
          (inventory.keyVersions[envelope.keyVersion] ?? 0) + 1
      }
      for (const row of rows) check(row.envelope, contextOf(row))
      for (const row of attempts) check(row.verifier, attemptContext(row))
      return inventory
    })
  } catch {
    // No driver objects, ciphertext, identifiers, or decrypted values escape this boundary.
    throw new Error("credential_storage_validation_failed")
  }
}

export async function initializeCredentialStorage(
  db: Database,
  env: NodeJS.ProcessEnv
) {
  try {
    const crypto = credentialCryptoFromEnv(env)
    const inventory = await validateCredentialStorage(db, crypto)
    return { crypto, inventory }
  } catch {
    throw new Error("credential_storage_validation_failed")
  }
}

// One bounded transaction is one resumable checkpoint. No user-facing connection or
// OAuth-client revision changes: only the ciphertext record's revision is advanced.
// Writers must be drained for a complete migration/retirement, because an old process
// could otherwise create an old-version envelope after this transaction commits.
export async function rotateCredentialBatch(
  db: Database,
  crypto: CredentialCrypto,
  batchSize = 100
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("invalid_rotation_batch_size")
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`)
      await tx.execute(sql`set local statement_timeout = '30s'`)
      await tx.execute(sql`select pg_advisory_xact_lock(711226, 1)`)
      // Same table order as credential replacement then OAuth-attempt invalidation.
      // Short exclusive-writer locks prevent overwrite/delete races within this batch.
      await tx.execute(
        sql`lock table credential_secrets, oauth_attempts in share row exclusive mode`
      )
      const rows = await tx
        .select()
        .from(credentialSecrets)
        .where(
          sql`${credentialSecrets.envelope}->>'keyVersion' is distinct from ${crypto.activeVersion}`
        )
        .orderBy(credentialSecrets.id)
        .limit(batchSize)
        .for("update")
      for (const row of rows) {
        const context = contextOf(row)
        const envelope = crypto.encrypt(
          crypto.decrypt(row.envelope, context),
          context
        )
        await tx
          .update(credentialSecrets)
          .set({
            envelope,
            revision: row.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(credentialSecrets.id, row.id))
      }
      const remaining = batchSize - rows.length
      const attempts =
        remaining > 0
          ? await tx
              .select()
              .from(oauthAttempts)
              .where(
                sql`${oauthAttempts.verifier}->>'keyVersion' is distinct from ${crypto.activeVersion}`
              )
              .orderBy(oauthAttempts.stateHash)
              .limit(remaining)
              .for("update")
          : []
      for (const row of attempts) {
        const context = attemptContext(row)
        await tx
          .update(oauthAttempts)
          .set({
            verifier: crypto.encrypt(
              crypto.decrypt(row.verifier, context),
              context
            ),
          })
          .where(eq(oauthAttempts.stateHash, row.stateHash))
      }
      return {
        rotated: rows.length + attempts.length,
        activeVersion: crypto.activeVersion,
      }
    })
  } catch {
    throw new Error("credential_rotation_failed")
  }
}
