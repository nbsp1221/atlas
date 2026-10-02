import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { eq, sql } from "drizzle-orm"
import {
  credentialSecrets,
  oauthAttempts,
  connections,
  oauthClients,
  createConnectionRepository,
  type Database,
} from "@workspace/db"
import { CredentialCrypto } from "../src/connections/crypto"
import {
  initializeCredentialStorage,
  rotateCredentialBatch,
  validateCredentialStorage,
} from "../src/connections/key-maintenance"

export async function verifyKeyMaintenance(
  db: Database,
  original: CredentialCrypto,
  originalKey: string
) {
  const nextKey = randomBytes(32).toString("base64")
  const dual = new CredentialCrypto("next", {
    unit: originalKey,
    next: nextKey,
  })
  const nextOnly = new CredentialCrypto("next", { next: nextKey })
  const wrong = new CredentialCrypto("unit", {
    unit: randomBytes(32).toString("base64"),
  })
  await assert.rejects(
    () => validateCredentialStorage(db, wrong),
    /credential_storage_validation_failed/
  )
  await assert.rejects(
    () => validateCredentialStorage(db, null),
    /credential_storage_validation_failed/
  )
  await assert.rejects(
    () => initializeCredentialStorage(db, {}),
    /credential_storage_validation_failed/
  )
  const attemptId = "isolated-maintenance-state"
  await db.insert(oauthAttempts).values({
    stateHash: attemptId,
    sessionId: "isolated-maintenance-session",
    label: "Fixture",
    clientRevision: 1,
    expiresAt: new Date(Date.now() + 600000),
    verifier: original.encrypt(
      { key: "synthetic-proof" },
      { id: attemptId, provider: "google", authType: "oauth_verifier" }
    ),
  })
  // Prototype-named version labels must be counted exactly, including in CLI inventories.
  const unusual = new CredentialCrypto(
    "__proto__",
    Object.fromEntries([["__proto__", originalKey]])
  )
  const unusualId = randomUUID()
  await db.insert(credentialSecrets).values({
    id: unusualId,
    providerKey: "fixture",
    authType: "fixture",
    envelope: unusual.encrypt(
      { key: "synthetic-unusual-version" },
      { id: unusualId, provider: "fixture", authType: "fixture" }
    ),
  })
  const allVersions = new CredentialCrypto(
    "next",
    Object.fromEntries([
      ["unit", originalKey],
      ["next", nextKey],
      ["__proto__", originalKey],
    ])
  )
  assert.equal(
    (await validateCredentialStorage(db, allVersions)).keyVersions["__proto__"],
    1
  )
  await db.delete(credentialSecrets).where(eq(credentialSecrets.id, unusualId))
  // A competing transaction cannot leave the operator hanging forever.
  let unlock!: () => void
  let acquired!: () => void
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const release = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const blocker = db.transaction(async (tx) => {
    await tx.execute(
      sql`lock table credential_secrets in share row exclusive mode`
    )
    acquired()
    await release
  })
  await locked
  try {
    await assert.rejects(
      () => rotateCredentialBatch(db, dual, 1),
      /credential_rotation_failed/
    )
  } finally {
    unlock()
    await blocker
  }
  const before = await db.select().from(credentialSecrets)
  const connectionBefore = await db.select().from(connections)
  const clientBefore = await db.select().from(oauthClients)
  const inventory = await validateCredentialStorage(db, dual)
  assert.equal(inventory.credentials, before.length)
  assert(inventory.attempts > 0)
  assert.equal(
    inventory.keyVersions.unit,
    inventory.credentials + inventory.attempts
  )
  // A corrupt row rolls the entire selected batch back, including earlier updates.
  const corrupt = [...before].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!
  await db
    .update(credentialSecrets)
    .set({
      envelope: {
        ...corrupt.envelope,
        authTag: Buffer.alloc(16).toString("base64"),
      },
    })
    .where(eq(credentialSecrets.id, corrupt.id))
  const damaged = await db
    .select()
    .from(credentialSecrets)
    .orderBy(credentialSecrets.id)
  await assert.rejects(
    () => rotateCredentialBatch(db, dual, 1000),
    /credential_rotation_failed/
  )
  assert.deepEqual(
    await db.select().from(credentialSecrets).orderBy(credentialSecrets.id),
    damaged
  )
  await db
    .update(credentialSecrets)
    .set({ envelope: corrupt.envelope })
    .where(eq(credentialSecrets.id, corrupt.id))
  await assert.rejects(
    () => rotateCredentialBatch(db, dual, 0),
    /invalid_rotation_batch_size/
  )
  const first = await rotateCredentialBatch(db, dual, 1)
  assert.equal(first.rotated, 1)
  const partial = await validateCredentialStorage(db, dual)
  assert.equal(partial.keyVersions.next, 1)
  assert(partial.keyVersions.unit > 0)
  await assert.rejects(
    () => validateCredentialStorage(db, nextOnly),
    /credential_storage_validation_failed/
  )
  // Simulates stop/restart: the next invocation resumes solely from persisted envelopes.
  while ((await rotateCredentialBatch(db, dual, 2)).rotated > 0) {
    /* bounded fixture */
  }
  assert.equal((await rotateCredentialBatch(db, dual, 2)).rotated, 0)
  await validateCredentialStorage(db, nextOnly)
  const after = await db.select().from(credentialSecrets)
  for (const row of after) {
    const old = before.find((item) => item.id === row.id)!
    const context = {
      id: row.id,
      provider: row.providerKey,
      authType: row.authType,
    }
    assert.deepEqual(
      nextOnly.decrypt(row.envelope, context),
      original.decrypt(old.envelope, context)
    )
    assert.equal(row.revision, old.revision + 1)
  }
  assert.deepEqual(await db.select().from(connections), connectionBefore)
  assert.deepEqual(await db.select().from(oauthClients), clientBefore)
  const [attempt] = await db
    .select()
    .from(oauthAttempts)
    .where(eq(oauthAttempts.stateHash, attemptId))
  assert.deepEqual(
    nextOnly.decrypt(attempt.verifier, {
      id: attemptId,
      provider: "google",
      authType: "oauth_verifier",
    }),
    { key: "synthetic-proof" }
  )
  // Replacement and rotation can contend without overwriting a new credential.
  const repo = createConnectionRepository(db)
  const target = connectionBefore.find((row) => row.credentialId)!
  const replacementId = randomUUID()
  await Promise.all([
    rotateCredentialBatch(db, dual, 100),
    repo.mutate(target.id, target.revision, async () => ({
      change: {
        secret: {
          id: replacementId,
          providerKey: target.providerKey,
          authType: "fixture",
          envelope: original.encrypt(
            { key: "synthetic-concurrent-replacement" },
            {
              id: replacementId,
              provider: target.providerKey,
              authType: "fixture",
            }
          ),
        },
      },
      result: null,
    })),
  ])
  await rotateCredentialBatch(db, dual, 100)
  const [replacement] = await db
    .select()
    .from(credentialSecrets)
    .where(eq(credentialSecrets.id, replacementId))
  assert.deepEqual(
    nextOnly.decrypt(replacement.envelope, {
      id: replacementId,
      provider: target.providerKey,
      authType: "fixture",
    }),
    { key: "synthetic-concurrent-replacement" }
  )
  assert.equal(
    (await repo.list()).find((row) => row.id === target.id)!.revision,
    target.revision + 1
  )
  // Historical backup envelopes still need old keys after the live rows are rotated.
  const old = before[0]
  assert.throws(
    () =>
      nextOnly.decrypt(old.envelope, {
        id: old.id,
        provider: old.providerKey,
        authType: old.authType,
      }),
    /credential_decryption_failed/
  )
  original.decrypt(old.envelope, {
    id: old.id,
    provider: old.providerKey,
    authType: old.authType,
  })
  const invoke = (args: string[], keys: Record<string, string>) =>
    spawnSync("pnpm", ["exec", "tsx", "src/credential-keys.ts", ...args], {
      env: {
        ...process.env,
        ATLAS_CREDENTIAL_KEYS_FILE: "",
        ATLAS_CREDENTIAL_KEYS: JSON.stringify(keys),
        ATLAS_CREDENTIAL_ACTIVE_KEY: "next",
      },
      encoding: "utf8",
    })
  const denied = invoke(["rotate"], { next: nextKey })
  assert.equal(denied.status, 1)
  const valid = invoke(["validate"], { next: nextKey })
  assert.equal(valid.status, 0)
  assert.equal(JSON.parse(valid.stdout.trim()).status, "validated")
  const done = invoke(
    ["rotate", "--apply", "--writers-stopped", "--backup-verified"],
    { next: nextKey }
  )
  assert.equal(done.status, 0)
  assert.equal(JSON.parse(done.stdout.trim()).status, "rotation_complete")
  const invalid = invoke(["validate"], {
    next: randomBytes(32).toString("base64"),
  })
  assert.equal(invalid.status, 1)
  for (const output of [valid, done, invalid, denied]) {
    assert(!output.stdout.includes(nextKey) && !output.stderr.includes(nextKey))
    assert(
      !output.stdout.includes("synthetic-") &&
        !output.stderr.includes("synthetic-")
    )
  }
  console.log(
    "Startup key validation, resumable/atomic rotation, revision concurrency, backup-key retention and CLI redaction: PASS"
  )
}
