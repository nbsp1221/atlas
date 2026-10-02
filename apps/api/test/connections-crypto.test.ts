import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import {
  CredentialCrypto,
  credentialCryptoFromEnv,
} from "../src/connections/crypto"
const context = { id: "fixture-id", provider: "google", authType: "oauth2" }
test("credential envelope is randomized authenticated and context-bound", () => {
  const crypto = new CredentialCrypto("v1", {
    v1: randomBytes(32).toString("base64"),
  })
  const payload = { key: "synthetic-canary-value" },
    a = crypto.encrypt(payload, context),
    b = crypto.encrypt(payload, context)
  assert.notEqual(a.ciphertext, b.ciphertext)
  assert.notEqual(a.nonce, b.nonce)
  assert.deepEqual(crypto.decrypt(a, context), payload)
  assert(!JSON.stringify(a).includes(payload.key))
  for (const changed of [
    { ...context, id: "different-id" },
    { ...context, provider: "telegram" },
    { ...context, authType: "api_key" },
  ])
    assert.throws(
      () => crypto.decrypt(a, changed),
      /credential_decryption_failed/
    )
  for (const field of ["nonce", "authTag", "ciphertext"] as const) {
    const bytes = Buffer.from(a[field], "base64")
    bytes[0] ^= 1
    assert.throws(
      () =>
        crypto.decrypt({ ...a, [field]: bytes.toString("base64") }, context),
      /credential_decryption_failed/
    )
  }
  assert.throws(
    () => crypto.decrypt({ ...a, formatVersion: 999 }, context),
    /credential_decryption_failed/
  )
})
test("key rotation decrypts old rows and writes new version; loss fails closed", () => {
  const v1 = randomBytes(32).toString("base64"),
    v2 = randomBytes(32).toString("base64")
  const old = new CredentialCrypto("v1", { v1 }),
    rotated = new CredentialCrypto("v2", { v1, v2 })
  const envelope = old.encrypt({ key: "synthetic" }, context)
  assert.deepEqual(rotated.decrypt(envelope, context), { key: "synthetic" })
  assert.equal(rotated.encrypt({}, context).keyVersion, "v2")
  assert.throws(
    () => new CredentialCrypto("v2", { v2 }).decrypt(envelope, context),
    /credential_decryption_failed/
  )
  assert.equal(credentialCryptoFromEnv({}), null)
  assert.throws(
    () => new CredentialCrypto("v1", { v1: "invalid" }),
    /invalid_credential_key_configuration/
  )
})
