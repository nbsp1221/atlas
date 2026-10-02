import { z } from "zod"

const connectionSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  providerKey: z.string(),
  status: z.enum(["active", "disabled", "archived"]),
  authState: z.enum([
    "missing",
    "unchecked",
    "ready",
    "reauth_required",
    "error",
  ]),
  principalId: z.string().nullable(),
  principalType: z.string().nullable(),
  grantedScopes: z.array(z.string()),
  lastCheckedAt: z.string().nullable(),
  usageCount: z.number(),
  hasSecret: z.boolean(),
  revision: z.number(),
  lastErrorCode: z.string().nullable(),
})
export type ManagedConnection = z.infer<typeof connectionSchema>
export const connectionSettingsSchema = z.object({
  connections: z.array(connectionSchema),
  oauthClients: z.array(
    z.object({
      providerKey: z.literal("google"),
      clientId: z.string(),
      hasSecret: z.boolean(),
      revision: z.number(),
    })
  ),
  credentialStorageAvailable: z.boolean(),
  callbackUrl: z.string().nullable(),
})
export type ConnectionAction =
  "replace" | "test" | "disconnect" | "forget" | "archive" | "revoke" | "resume"
const messages: Record<string, string> = {
  reauthentication_required: "Sign in again before changing credentials.",
  connection_changed: "This connection changed. Refresh and try again.",
  oauth_client_in_use:
    "Forget or revoke existing Google credentials before changing the OAuth client ID.",
  oauth_client_changed: "The Google client changed. Start authorization again.",
  account_mismatch:
    "The provider account differs from this connection’s verified identity. Add a separate connection instead.",
  revision_conflict: "This connection changed. Refresh and try again.",
  conflict: "This connection changed. Refresh and try again.",
  credential_storage_unavailable:
    "Credential storage is unavailable. Ask the administrator to configure it.",
  auth_not_configured: "Administrator sign-in is not configured.",
}
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
    },
    ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(
      (payload?.error && messages[payload.error]) ||
        (response.status === 401
          ? "Your session expired. Sign in again."
          : "The request could not be completed. Refresh and try again.")
    )
  }
  const result = schema.safeParse(await response.json())
  if (!result.success)
    throw new Error(
      "The server returned an unexpected response. Refresh and try again."
    )
  return result.data
}
const base = "/api/settings/connections"
const mutationSchema = z.object({ connection: connectionSchema })
export const getConnectionSettings = () =>
  request(base, connectionSettingsSchema)
export const createApiKeyConnection = (body: {
  providerKey: "openai" | "anthropic" | "telegram"
  label: string
  secret: string
}) => request(`${base}/api-key`, mutationSchema, "POST", body)
export const actOnConnection = (
  connection: ManagedConnection,
  action: ConnectionAction,
  secret?: string
) =>
  request(
    `${base}/${encodeURIComponent(connection.id)}/${action}`,
    mutationSchema,
    "POST",
    { revision: connection.revision, ...(secret ? { secret } : {}) }
  )
export const saveGoogleClient = (body: {
  clientId: string
  clientSecret: string
  revision?: number
}) => request("/api/settings/oauth-clients/google", z.unknown(), "PUT", body)
export async function authorizeGoogle(body: {
  label?: string
  connectionId?: string
  revision?: number
}) {
  const result = await request(
    `${base}/google/authorize`,
    z.object({ authorizationUrl: z.string() }),
    "POST",
    body
  )
  const url = new URL(result.authorizationUrl)
  if (
    url.origin !== "https://accounts.google.com" ||
    !url.pathname.startsWith("/o/oauth2/")
  )
    throw new Error("The server returned an invalid authorization destination.")
  return url.href
}
