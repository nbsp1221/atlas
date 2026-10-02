import type { Context, MiddlewareHandler } from "hono"
import {
  ATLAS_OWNER_ID,
  AUTH_BODY_LIMIT_BYTES,
  FRESH_SECONDS,
  GOOGLE_CALLBACK_PATH,
  SESSION_SECONDS,
  type AdminAuthConfig,
} from "./config"

export type OwnerSession = {
  user: {
    id: string
    email: string
    name: string
  }
  session: {
    id: string
    userId: string
    createdAt: Date
    expiresAt: Date
  }
}

export type AuthBackend = {
  handler: (request: Request) => Promise<Response>
  getSession: (headers: Headers) => Promise<OwnerSession | null>
}

type JsonObject = Record<string, unknown>

function jsonResponse(
  body: unknown,
  status: number,
  upstream?: Response
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })

  // Preserve only the authentication cookies. Never forward arbitrary
  // library response headers, redirects, or stale content lengths.
  if (upstream) {
    for (const cookie of upstream.headers.getSetCookie()) {
      headers.append("Set-Cookie", cookie)
    }
  }

  return new Response(JSON.stringify(body), { status, headers })
}

function failure(error: string, status: number): Response {
  return jsonResponse({ error }, status)
}

function isMutation(request: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method)
}

export function requestBoundaryError(
  request: Request,
  config: AdminAuthConfig
): Response | null {
  const url = new URL(request.url)
  if (url.pathname === GOOGLE_CALLBACK_PATH && request.method !== "GET")
    return failure("method_not_allowed", 405)

  // Deliberately do not interpret X-Forwarded-Proto, X-Forwarded-Host,
  // or Tailscale identity headers as trustworthy transport/identity.
  if (url.protocol !== "https:" || url.origin !== config.origin) {
    return failure("secure_origin_required", 403)
  }

  // Atlas uses same-origin web/API access, not a cross-origin API.
  if (request.method === "OPTIONS") {
    return failure("method_not_allowed", 405)
  }

  const callback =
    request.method === "GET" && url.pathname === GOOGLE_CALLBACK_PATH

  const site = request.headers.get("sec-fetch-site")
  const mode = request.headers.get("sec-fetch-mode")
  const destination = request.headers.get("sec-fetch-dest")
  const origin = request.headers.get("origin")

  if (site === "cross-site") {
    if (!callback) {
      return failure("cross_site_request", 403)
    }

    // Google returns through a top-level browser navigation.
    // Missing Fetch Metadata is tolerated for browser compatibility;
    // the service still requires valid one-use, session-bound state.
    if (
      (mode !== null && mode !== "navigate") ||
      (destination !== null && destination !== "document")
    ) {
      return failure("invalid_callback_navigation", 403)
    }
  }

  if (isMutation(request)) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      return failure("method_not_allowed", 405)
    }

    if (origin !== config.origin) {
      return failure("untrusted_origin", 403)
    }

    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase()

    if (contentType !== "application/json") {
      return failure("json_required", 415)
    }
  } else if (!callback && origin !== null && origin !== config.origin) {
    return failure("untrusted_origin", 403)
  }

  return null
}

async function readJsonObject(
  request: Request
): Promise<JsonObject | Response> {
  if (!request.body) {
    return failure("invalid_request", 400)
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break

      length += result.value.byteLength
      if (length > AUTH_BODY_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined)
        return failure("request_too_large", 413)
      }

      chunks.push(result.value)
    }
  } catch {
    return failure("invalid_request", 400)
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    )

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return failure("invalid_request", 400)
    }

    return parsed as JsonObject
  } catch {
    return failure("invalid_request", 400)
  }
}

function hasOnlyKeys(input: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key))
}

function normalizedAuthBody(
  path: string,
  input: JsonObject
): JsonObject | Response {
  if (path === "/api/auth/sign-in/email") {
    if (
      !hasOnlyKeys(input, ["email", "password"]) ||
      typeof input.email !== "string" ||
      input.email.length > 320 ||
      typeof input.password !== "string" ||
      input.password.length === 0 ||
      input.password.length > 128
    ) {
      return failure("invalid_request", 400)
    }

    // Do not accept callbackURL or an arbitrary redirect destination.
    return {
      email: input.email.trim().toLowerCase(),
      password: input.password,
    }
  }

  if (path === "/api/auth/change-password") {
    if (
      !hasOnlyKeys(input, [
        "currentPassword",
        "newPassword",
        "revokeOtherSessions",
      ]) ||
      typeof input.currentPassword !== "string" ||
      input.currentPassword.length === 0 ||
      input.currentPassword.length > 128 ||
      typeof input.newPassword !== "string" ||
      input.newPassword.length < 12 ||
      input.newPassword.length > 128 ||
      (input.revokeOtherSessions !== undefined &&
        typeof input.revokeOtherSessions !== "boolean")
    ) {
      return failure("invalid_request", 400)
    }

    return {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      // This endpoint's body flag is separate from password-reset
      // configuration. The browser cannot opt out of revocation.
      revokeOtherSessions: true,
    }
  }

  if (Object.keys(input).length !== 0) {
    return failure("invalid_request", 400)
  }

  return {}
}

function rebuildAuthRequest(request: Request, body: JsonObject): Request {
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "application/json")

  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  })
}

export function createAdminBoundary(
  config: AdminAuthConfig | null,
  backend: AuthBackend | null,
  now: () => number = Date.now
) {
  // Request-local identity only. No session token is put into Context.
  const identities = new WeakMap<Context, OwnerSession>()

  let loginWindowStart = now()
  let loginCount = 0
  let passwordWindowStart = now()
  let passwordCount = 0

  async function getOwner(
    request: Request,
    fresh = false
  ): Promise<OwnerSession | Response> {
    if (!config || !backend) {
      return failure("auth_not_configured", 503)
    }

    const boundaryError = requestBoundaryError(request, config)
    if (boundaryError) return boundaryError

    let data: OwnerSession | null
    try {
      data = await backend.getSession(request.headers)
    } catch {
      return failure("auth_unavailable", 503)
    }

    if (!data) {
      return failure("unauthorized", 401)
    }

    if (
      data.user.id !== ATLAS_OWNER_ID ||
      data.session.userId !== ATLAS_OWNER_ID
    ) {
      return failure("forbidden", 403)
    }

    const current = now()
    const created = data.session.createdAt.getTime()
    const expires = data.session.expiresAt.getTime()

    if (
      !Number.isFinite(created) ||
      !Number.isFinite(expires) ||
      created > current ||
      expires <= current ||
      current - created >= SESSION_SECONDS * 1000
    ) {
      return failure("unauthorized", 401)
    }

    if (fresh && current - created >= FRESH_SECONDS * 1000) {
      return failure("reauthentication_required", 403)
    }

    return data
  }

  function middleware(fresh: boolean): MiddlewareHandler {
    return async (context, next) => {
      const owner = await getOwner(context.req.raw, fresh)
      if (owner instanceof Response) return owner

      identities.set(context, owner)
      context.header("Cache-Control", "no-store")
      context.header("Referrer-Policy", "no-referrer")
      await next()
    }
  }

  function sessionId(context: Context): string {
    const owner = identities.get(context)
    if (!owner) {
      throw new Error("owner_session_required")
    }

    // Database session identifier, not the bearer token.
    return owner.session.id
  }

  async function handler(request: Request): Promise<Response> {
    if (!config || !backend) {
      return failure("auth_not_configured", 503)
    }

    const boundaryError = requestBoundaryError(request, config)
    if (boundaryError) return boundaryError

    const path = new URL(request.url).pathname

    if (path === "/api/auth/get-session" && request.method === "GET") {
      const owner = await getOwner(request)
      if (owner instanceof Response) return owner

      return jsonResponse(
        {
          user: {
            id: owner.user.id,
            email: owner.user.email,
            name: owner.user.name,
          },
          session: {
            id: owner.session.id,
            createdAt: owner.session.createdAt,
            expiresAt: owner.session.expiresAt,
          },
        },
        200
      )
    }

    const allowedPaths = [
      "/api/auth/sign-in/email",
      "/api/auth/sign-out",
      "/api/auth/change-password",
    ]

    if (request.method !== "POST" || !allowedPaths.includes(path)) {
      // Signup, social login, account linking, password-reset and
      // unreviewed library endpoints are not publicly exposed.
      return failure("not_found", 404)
    }

    if (path === "/api/auth/sign-in/email") {
      const current = now()
      if (current < loginWindowStart || current - loginWindowStart >= 60_000) {
        loginWindowStart = current
        loginCount = 0
      }

      // Supplemental single-owner bucket. Forging forwarded IP
      // headers cannot bypass it. A process restart resets this bucket.
      loginCount += 1
      if (loginCount > 10) {
        return failure("too_many_attempts", 429)
      }
    } else {
      const owner = await getOwner(
        request,
        path === "/api/auth/change-password"
      )
      if (owner instanceof Response) return owner
      if (path === "/api/auth/change-password") {
        const current = now()
        if (
          current < passwordWindowStart ||
          current - passwordWindowStart >= 60_000
        ) {
          passwordWindowStart = current
          passwordCount = 0
        }
        if (++passwordCount > 5) return failure("too_many_attempts", 429)
      }
    }

    const input = await readJsonObject(request)
    if (input instanceof Response) return input

    const body = normalizedAuthBody(path, input)
    if (body instanceof Response) return body

    let response: Response
    try {
      response = await backend.handler(rebuildAuthRequest(request, body))
    } catch {
      return failure("auth_unavailable", 503)
    }

    // Better Auth may put bearer tokens in sign-in and
    // change-password JSON. Never forward its response body.
    await response.body?.cancel().catch(() => undefined)

    if (response.ok) {
      return jsonResponse({ success: true }, 200, response)
    }

    if (response.status === 429) {
      return jsonResponse({ error: "too_many_attempts" }, 429, response)
    }

    if (response.status >= 500) {
      return jsonResponse({ error: "auth_unavailable" }, 503, response)
    }

    const status =
      response.status >= 400 && response.status < 500 ? response.status : 502

    return jsonResponse({ error: "authentication_failed" }, status, response)
  }

  return {
    configured: Boolean(config && backend),
    handler,
    getOwner,
    requireOwner: middleware(false),
    requireFreshOwner: middleware(true),
    sessionId,
  }
}
