import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

export type SecretEnvelope = {
  formatVersion: number
  keyVersion: string
  nonce: string
  ciphertext: string
  authTag: string
}
export type SecretContext = { id: string; provider: string; authType: string }
const aad = (context: SecretContext) =>
  Buffer.from(
    JSON.stringify([
      "atlas-credential",
      1,
      context.id,
      context.provider,
      context.authType,
    ])
  )
export class CredentialCrypto {
  private keys: Map<string, Buffer>
  constructor(
    readonly activeVersion: string,
    keys: Record<string, string>
  ) {
    this.keys = new Map(
      Object.entries(keys).map(([version, encoded]) => {
        const key = Buffer.from(encoded, "base64")
        if (!version || key.length !== 32 || key.toString("base64") !== encoded)
          throw new Error("invalid_credential_key_configuration")
        return [version, key]
      })
    )
    if (!this.keys.has(activeVersion))
      throw new Error("invalid_credential_key_configuration")
  }
  encrypt(value: unknown, context: SecretContext): SecretEnvelope {
    const nonce = randomBytes(12)
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keys.get(this.activeVersion)!,
      nonce,
      { authTagLength: 16 }
    )
    cipher.setAAD(aad(context))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ])
    return {
      formatVersion: 1,
      keyVersion: this.activeVersion,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    }
  }
  decrypt(envelope: SecretEnvelope, context: SecretContext): unknown {
    try {
      const key = this.keys.get(envelope.keyVersion)
      const nonce = Buffer.from(envelope.nonce, "base64"),
        tag = Buffer.from(envelope.authTag, "base64")
      if (
        !key ||
        envelope.formatVersion !== 1 ||
        nonce.length !== 12 ||
        tag.length !== 16
      )
        throw new Error()
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
        authTagLength: 16,
      })
      decipher.setAAD(aad(context))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ])
      return JSON.parse(plaintext.toString("utf8"))
    } catch {
      throw new Error("credential_decryption_failed")
    }
  }
}
// Deployment configuration only. Never creates a key or falls back to plaintext.
export function credentialCryptoFromEnv(
  env: NodeJS.ProcessEnv
): CredentialCrypto | null {
  const encoded = env.ATLAS_CREDENTIAL_KEYS_FILE
    ? readFileSync(env.ATLAS_CREDENTIAL_KEYS_FILE, "utf8")
    : env.ATLAS_CREDENTIAL_KEYS
  if (!encoded) return null
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => typeof v !== "string")
    )
      throw new Error()
    return new CredentialCrypto(
      env.ATLAS_CREDENTIAL_ACTIVE_KEY ?? "v1",
      parsed as Record<string, string>
    )
  } catch {
    throw new Error("invalid_credential_key_configuration")
  }
}
