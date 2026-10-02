import { createHash, randomUUID } from "node:crypto"
import type {
  ConnectionRepository,
  ConnectionRow,
  NewSecret,
  SecretRow,
} from "@workspace/db"
import {
  checkAnthropic,
  checkOpenAI,
  checkTelegram,
  checkGoogle,
  exchangeGoogleCode,
  refreshGoogleTokens,
  revokeGoogleTokens,
  newOAuthProof,
  googleAuthorizationUrl,
  GOOGLE_SCOPES,
  ProviderError,
  GoogleGrantError,
  type GoogleClient,
  type GoogleTokens,
} from "@workspace/integrations"
import { CredentialCrypto } from "./crypto"
export class ConnectionError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
type ApiKeyProvider = "openai" | "anthropic" | "telegram"
export const defaultProviderOperations = {
  checkOpenAI,
  checkAnthropic,
  checkTelegram,
  checkGoogle,
  exchangeGoogleCode,
  refreshGoogleTokens,
  revokeGoogleTokens,
}
export type ProviderOperations = typeof defaultProviderOperations
function readKey(payload: unknown): string {
  const key = (payload as { key?: unknown })?.key
  if (typeof key !== "string" || !key)
    throw new ConnectionError("credential_invalid")
  return key
}
function readTokens(payload: unknown): GoogleTokens {
  const t = payload as GoogleTokens
  if (
    !t ||
    typeof t.accessToken !== "string" ||
    typeof t.expiresAt !== "number" ||
    !Array.isArray(t.scopes)
  )
    throw new ConnectionError("credential_invalid")
  return t
}
function scopes(row: ConnectionRow): string[] {
  const value = row.grants.scopes
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : []
}
function errorCode(error: unknown) {
  return error instanceof GoogleGrantError
    ? "reauth_required"
    : error instanceof ProviderError
      ? error.code
      : "connection_check_failed"
}
export function createConnectionService(
  repository: ConnectionRepository,
  crypto: CredentialCrypto | null,
  origin: string | null,
  provider: ProviderOperations = defaultProviderOperations
) {
  if (
    origin &&
    (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
  )
    throw new ConnectionError("oauth_origin_invalid")
  const callbackUrl = origin
    ? `${origin}/api/settings/connections/google/callback`
    : null
  const requireCrypto = () => {
    if (!crypto) throw new ConnectionError("credential_storage_unavailable")
    return crypto
  }
  const decrypt = (secret: SecretRow) =>
    requireCrypto().decrypt(secret.envelope, {
      id: secret.id,
      provider: secret.providerKey,
      authType: secret.authType,
    })
  function newSecret(
    providerKey: string,
    authType: string,
    payload: unknown
  ): NewSecret {
    const id = randomUUID()
    return {
      id,
      providerKey,
      authType,
      envelope: requireCrypto().encrypt(payload, {
        id,
        provider: providerKey,
        authType,
      }),
    }
  }
  async function metadata(row: ConnectionRow) {
    return {
      id: row.id,
      key: row.key,
      label: row.label,
      providerKey: row.providerKey,
      status: row.status,
      authState: row.authState,
      principalId: row.externalPrincipalId,
      principalType: row.externalPrincipalType,
      grantedScopes: scopes(row),
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      usageCount: (await repository.usage(row.key, row.id)).length,
      hasSecret: !!row.credentialId,
      revision: row.revision,
      lastErrorCode:
        typeof row.lastError?.code === "string" &&
        [
          "provider_auth_rejected",
          "provider_unavailable",
          "provider_invalid_response",
          "provider_rate_limited",
          "reauth_required",
          "insufficient_grants",
          "account_mismatch",
          "connection_check_failed",
          "revocation_failed",
        ].includes(row.lastError.code)
          ? row.lastError.code
          : null,
    }
  }
  async function googleClient(): Promise<GoogleClient & { revision: number }> {
    if (!callbackUrl) throw new ConnectionError("oauth_origin_unconfigured")
    const row = await repository.googleClient()
    if (!row) throw new ConnectionError("oauth_client_unconfigured")
    return {
      clientId: row.client.clientId,
      clientSecret: readKey(decrypt(row.secret)),
      redirectUri: callbackUrl,
      revision: row.client.revision,
    }
  }
  async function probeKey(providerKey: string, key: string) {
    if (providerKey === "openai") return provider.checkOpenAI(key)
    if (providerKey === "anthropic") return provider.checkAnthropic(key)
    if (providerKey === "telegram") return provider.checkTelegram(key)
    throw new ConnectionError("unsupported_provider")
  }
  return {
    async list() {
      return {
        connections: await Promise.all((await repository.list()).map(metadata)),
        oauthClients: (await repository.listOAuthClients()).map((c) => ({
          ...c,
          hasSecret: true,
        })),
        credentialStorageAvailable: !!crypto,
        callbackUrl,
      }
    },
    async addApiKey(input: {
      providerKey: ApiKeyProvider
      label: string
      secret: string
    }) {
      const row = await repository.create({
        id: randomUUID(),
        providerKey: input.providerKey,
        label: input.label,
        secret: newSecret(input.providerKey, "api_key", { key: input.secret }),
      })
      return { connection: await metadata(row) }
    },
    async replace(id: string, revision: number, key: string) {
      const { connection } = await repository.mutate(
        id,
        revision,
        async (row) => {
          if (row.status === "archived" || row.providerKey === "google")
            throw new ConnectionError("replacement_not_allowed")
          const checked = await probeKey(row.providerKey, key)
          if (
            row.externalPrincipalId &&
            checked.principalId !== row.externalPrincipalId
          )
            throw new ConnectionError("account_mismatch")
          return {
            change: {
              secret: newSecret(row.providerKey, "api_key", { key }),
              authState: "ready",
              lastCheckStatus: "healthy",
              lastCheckedAt: new Date(),
              lastError: null,
              externalPrincipalType: checked.principalType,
              externalPrincipalId: checked.principalId,
              grants: { scopes: checked.scopes },
            },
            result: null,
          }
        }
      )
      return { connection: await metadata(connection) }
    },
    async test(id: string, revision: number) {
      const { connection } = await repository.mutate(
        id,
        revision,
        async (row, secret) => {
          if (!secret || row.status === "archived")
            throw new ConnectionError("connection_missing_credentials")
          let replacement: NewSecret | undefined
          try {
            let checked
            if (row.providerKey === "google") {
              let tokens = readTokens(decrypt(secret))
              if (tokens.expiresAt < Date.now() + 60000) {
                tokens = await provider.refreshGoogleTokens(
                  await googleClient(),
                  tokens
                )
                replacement = newSecret("google", "oauth2", tokens)
              }
              checked = await provider.checkGoogle(tokens)
              if (
                !tokens.refreshToken ||
                !GOOGLE_SCOPES.every((scope) => tokens.scopes.includes(scope))
              )
                throw new ConnectionError("insufficient_grants")
            } else
              checked = await probeKey(
                row.providerKey,
                readKey(decrypt(secret))
              )
            if (
              row.externalPrincipalId &&
              checked.principalId !== row.externalPrincipalId
            )
              throw new ConnectionError("account_mismatch")
            return {
              change: {
                secret: replacement,
                authState: "ready" as const,
                lastCheckStatus: "healthy" as const,
                lastCheckedAt: new Date(),
                lastError: null,
                externalPrincipalType: checked.principalType,
                externalPrincipalId: checked.principalId,
                grants: { scopes: checked.scopes },
              },
              result: null,
            }
          } catch (error) {
            const code =
              error instanceof ConnectionError ? error.code : errorCode(error)
            return {
              change: {
                secret: replacement,
                authState:
                  code === "reauth_required"
                    ? ("reauth_required" as const)
                    : ("error" as const),
                lastCheckStatus: "error" as const,
                lastCheckedAt: new Date(),
                lastError: { code },
              },
              result: null,
            }
          }
        }
      )
      return { connection: await metadata(connection) }
    },
    async lifecycle(
      id: string,
      revision: number,
      operation: "disconnect" | "forget" | "archive" | "revoke" | "resume"
    ) {
      const { connection } = await repository.mutate(
        id,
        revision,
        async (row, secret) => {
          if (operation === "resume") {
            if (
              row.status !== "disabled" ||
              row.authState !== "ready" ||
              !secret
            )
              throw new ConnectionError("connection_unavailable")
            return { change: { status: "active" as const }, result: null }
          }
          if (operation === "revoke") {
            if (row.providerKey !== "google" || !secret)
              throw new ConnectionError("revoke_not_available")
            try {
              await provider.revokeGoogleTokens(readTokens(decrypt(secret)))
            } catch {
              return {
                change: {
                  status: "disabled" as const,
                  authState: "error" as const,
                  lastCheckStatus: "error" as const,
                  lastError: { code: "revocation_failed" },
                },
                result: null,
              }
            }
          }
          return {
            change: {
              status:
                operation === "archive"
                  ? ("archived" as const)
                  : ("disabled" as const),
              ...(operation !== "disconnect"
                ? {
                    clearSecret: true,
                    authState: "missing" as const,
                    lastError: null,
                  }
                : {}),
            },
            result: null,
          }
        }
      )
      return { connection: await metadata(connection) }
    },
    async saveGoogleClient(input: {
      clientId: string
      clientSecret: string
      revision?: number
    }) {
      await repository.saveGoogleClient(
        input.clientId,
        newSecret("google", "oauth_client_secret", { key: input.clientSecret }),
        input.revision
      )
      return { ok: true }
    },
    async authorize(input: {
      sessionId: string
      label?: string
      connectionId?: string
      revision?: number
    }) {
      const client = await googleClient(),
        proof = newOAuthProof()
      let label = input.label ?? "Google account"
      if (input.connectionId) {
        const row = (await repository.list()).find(
          (r) => r.id === input.connectionId
        )
        if (
          !row ||
          row.providerKey !== "google" ||
          row.status === "archived" ||
          row.revision !== input.revision
        )
          throw new ConnectionError("connection_changed")
        label = row.label
      }
      await repository.createAttempt({
        stateHash: proof.stateHash,
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        connectionRevision: input.revision,
        label,
        clientRevision: client.revision,
        verifier: requireCrypto().encrypt(
          { key: proof.verifier },
          {
            id: proof.stateHash,
            provider: "google",
            authType: "oauth_verifier",
          }
        ),
        expiresAt: new Date(Date.now() + 10 * 60000),
      })
      return {
        authorizationUrl: googleAuthorizationUrl(
          client,
          proof.state,
          proof.verifier
        ),
      }
    },
    async callback(input: {
      sessionId: string
      state: string
      code?: string
      denied?: boolean
    }) {
      const hash = createHash("sha256").update(input.state).digest("hex")
      const attempt = await repository.consumeAttempt(hash, input.sessionId)
      if (!attempt) throw new ConnectionError("oauth_attempt_invalid")
      if (input.denied || !input.code)
        throw new ConnectionError("oauth_consent_denied")
      const client = await googleClient()
      if (client.revision !== attempt.clientRevision)
        throw new ConnectionError("oauth_client_changed")
      const verifier = readKey(
        requireCrypto().decrypt(attempt.verifier, {
          id: hash,
          provider: "google",
          authType: "oauth_verifier",
        })
      )
      const tokens = await provider.exchangeGoogleCode(
        client,
        input.code,
        verifier
      )
      const checked = await provider.checkGoogle(tokens)
      if (attempt.connectionId) {
        const { connection } = await repository.mutate(
          attempt.connectionId,
          attempt.connectionRevision ?? undefined,
          async (row, secret) => {
            if (
              row.status === "archived" ||
              row.providerKey !== "google" ||
              (row.externalPrincipalId !== null &&
                row.externalPrincipalId !== checked.principalId)
            )
              throw new ConnectionError("account_mismatch")
            if (!tokens.refreshToken && secret)
              tokens.refreshToken = readTokens(decrypt(secret)).refreshToken
            const ready =
              !!tokens.refreshToken &&
              GOOGLE_SCOPES.every((s) => tokens.scopes.includes(s))
            return {
              change: {
                secret: newSecret("google", "oauth2", tokens),
                externalPrincipalType: checked.principalType,
                externalPrincipalId: checked.principalId,
                status: "active",
                authState: ready ? "ready" : "reauth_required",
                grants: { scopes: tokens.scopes },
                lastCheckedAt: new Date(),
                lastCheckStatus: ready ? "healthy" : "error",
                lastError: ready ? null : { code: "insufficient_grants" },
              },
              result: null,
            }
          },
          client.revision
        )
        return { connection: await metadata(connection) }
      }
      const ready =
        !!tokens.refreshToken &&
        GOOGLE_SCOPES.every((s) => tokens.scopes.includes(s))
      const connection = await repository.create({
        id: randomUUID(),
        providerKey: "google",
        oauthClientRevision: client.revision,
        label: attempt.label,
        secret: newSecret("google", "oauth2", tokens),
        principalType: checked.principalType,
        principalId: checked.principalId,
        grants: { scopes: tokens.scopes },
        authState: ready ? "ready" : "reauth_required",
      })
      return { connection: await metadata(connection) }
    },
    async resolveLive(
      id: string,
      providerKey: string,
      requiredScopes: string[]
    ) {
      const { result } = await repository.mutate(
        id,
        undefined,
        async (row, secret) => {
          if (
            row.status !== "active" ||
            row.authState !== "ready" ||
            row.providerKey !== providerKey ||
            !secret ||
            !requiredScopes.every((scope) => scopes(row).includes(scope))
          )
            throw new ConnectionError("connection_unavailable")
          let payload = decrypt(secret)
          if (providerKey === "google") {
            const tokens = readTokens(payload)
            if (tokens.expiresAt < Date.now() + 60000) {
              try {
                payload = await provider.refreshGoogleTokens(
                  await googleClient(),
                  tokens
                )
              } catch (error) {
                if (error instanceof GoogleGrantError)
                  return {
                    change: {
                      authState: "reauth_required" as const,
                      lastError: { code: "reauth_required" },
                    },
                    result: null,
                  }
                throw error
              }
              const refreshed = readTokens(payload)
              if (
                !requiredScopes.every((scope) =>
                  refreshed.scopes.includes(scope)
                )
              )
                return {
                  change: {
                    secret: newSecret("google", "oauth2", payload),
                    grants: { scopes: refreshed.scopes },
                    authState: "reauth_required" as const,
                    lastError: { code: "insufficient_grants" },
                  },
                  result: null,
                }
              return {
                change: {
                  secret: newSecret("google", "oauth2", payload),
                  grants: { scopes: refreshed.scopes },
                },
                result: payload,
              }
            }
          }
          return { change: {}, result: payload }
        },
        undefined,
        false
      )
      if (!result) throw new ConnectionError("reauth_required")
      return result
    },
  }
}
export type ConnectionService = ReturnType<typeof createConnectionService>
