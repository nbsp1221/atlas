import { createHash, randomBytes } from "node:crypto"
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library"
import {
  providerJson,
  ProviderError,
  type ProviderFetch,
  type ProbeResult,
} from "../http"
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
]
function normalizeScope(scope: string) {
  return scope === "https://www.googleapis.com/auth/userinfo.email"
    ? "email"
    : scope
}
export type GoogleTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scopes: string[]
}
export type GoogleClient = {
  clientId: string
  clientSecret: string
  redirectUri: string
}
export class GoogleGrantError extends Error {
  constructor() {
    super("reauth_required")
  }
}
export function newOAuthProof() {
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url")
  return {
    state,
    verifier,
    stateHash: createHash("sha256").update(state).digest("hex"),
  }
}
export function googleAuthorizationUrl(
  client: GoogleClient,
  state: string,
  verifier: string
) {
  return new OAuth2Client(
    client.clientId,
    client.clientSecret,
    client.redirectUri
  ).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  })
}
async function tokenRequest(
  body: URLSearchParams,
  transport: ProviderFetch
): Promise<Record<string, unknown>> {
  try {
    const response = await transport("https://oauth2.googleapis.com/token", {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const json: unknown = await response.json()
    if (!json || typeof json !== "object")
      throw new ProviderError("provider_invalid_response")
    const data = json as Record<string, unknown>
    if (!response.ok) {
      if (data.error === "invalid_grant") throw new GoogleGrantError()
      throw new ProviderError("provider_unavailable")
    }
    return data
  } catch (error) {
    if (error instanceof GoogleGrantError || error instanceof ProviderError)
      throw error
    throw new ProviderError("provider_unavailable")
  }
}
function parseTokens(
  data: Record<string, unknown>,
  previous?: GoogleTokens
): GoogleTokens {
  if (
    typeof data.access_token !== "string" ||
    typeof data.expires_in !== "number" ||
    data.expires_in <= 0 ||
    (data.token_type as string)?.toLowerCase() !== "bearer"
  )
    throw new ProviderError("provider_invalid_response")
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : previous?.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes:
      typeof data.scope === "string"
        ? data.scope.split(/\s+/).map(normalizeScope)
        : (previous?.scopes ?? []),
  }
}
export async function exchangeGoogleCode(
  client: GoogleClient,
  code: string,
  verifier: string,
  transport: ProviderFetch = fetch
): Promise<GoogleTokens> {
  const data = await tokenRequest(
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    }),
    transport
  )
  return parseTokens(data)
}
export async function refreshGoogleTokens(
  client: GoogleClient,
  previous: GoogleTokens,
  transport: ProviderFetch = fetch
): Promise<GoogleTokens> {
  if (!previous.refreshToken) throw new GoogleGrantError()
  const data = await tokenRequest(
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
    }),
    transport
  )
  return parseTokens(data, previous)
}
export async function checkGoogle(
  tokens: GoogleTokens,
  transport?: ProviderFetch
): Promise<ProbeResult> {
  const data = await providerJson(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    transport
  )
  if (typeof data.sub !== "string" || !data.sub || data.email_verified !== true)
    throw new ProviderError("provider_invalid_response")
  // Account identity comes only from Google's authenticated TLS endpoint, never a submitted email.
  return {
    principalType: "google-sub",
    principalId: data.sub,
    scopes: tokens.scopes,
  }
}
export async function revokeGoogleTokens(
  tokens: GoogleTokens,
  transport: ProviderFetch = fetch
) {
  try {
    const response = await transport("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.refreshToken ?? tokens.accessToken,
      }),
    })
    if (!response.ok) throw new ProviderError("provider_unavailable")
  } catch {
    throw new ProviderError("provider_unavailable")
  }
}
