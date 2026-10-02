import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import {
  createAdminBoundary,
  requestBoundaryError,
  type OwnerSession,
  type AuthBackend,
} from "../src/auth/boundary"
import {
  readAdminAuthConfig,
  SESSION_SECONDS,
  FRESH_SECONDS,
} from "../src/auth/config"
import { listenerOptions } from "../src/transport"

const origin = "https://atlas.example.test"
const config = { origin, secret: "synthetic-test-configuration-value-only" }
const current = Date.UTC(2026, 9, 1)
function owner(age = 0): OwnerSession {
  return {
    user: { id: "atlas-owner", email: "owner@example.test", name: "Owner" },
    session: {
      id: "database-session-id",
      userId: "atlas-owner",
      createdAt: new Date(current - age),
      expiresAt: new Date(current + SESSION_SECONDS * 1000),
    },
  }
}
function request(
  path = "/api/overview",
  method = "GET",
  headers: Record<string, string> = {},
  body?: string
) {
  return new Request(origin + path, {
    method,
    headers: {
      ...(method !== "GET"
        ? { origin, "content-type": "application/json" }
        : {}),
      ...headers,
    },
    body,
  })
}
function backend(
  data: OwnerSession | null = owner(),
  handler: AuthBackend["handler"] = async () =>
    Response.json(
      { token: "must-never-escape" },
      {
        headers: {
          "set-cookie":
            "__Secure-better-auth.session_token=test; HttpOnly; Secure; SameSite=Lax; Path=/",
        },
      }
    )
) {
  return { getSession: async () => data, handler }
}

test("configuration and listener fail closed without canonical HTTPS and explicit TLS", () => {
  assert.equal(readAdminAuthConfig({}), null)
  for (const url of [
    "http://atlas.example.test",
    origin + "/path",
    origin + "?query=x",
    "https://user@atlas.example.test",
    origin + "#fragment",
  ])
    assert.equal(
      readAdminAuthConfig({
        ATLAS_AUTH_SECRET: config.secret,
        ATLAS_PUBLIC_URL: url,
      }),
      null
    )
  assert.deepEqual(
    readAdminAuthConfig({
      ATLAS_AUTH_SECRET: config.secret,
      ATLAS_PUBLIC_URL: origin,
    }),
    config
  )
  assert.throws(
    () =>
      listenerOptions({
        ATLAS_AUTH_SECRET: config.secret,
        ATLAS_PUBLIC_URL: origin,
      }),
    /native_tls_required/
  )
  assert.throws(
    () => listenerOptions({ ATLAS_TLS_CERT_FILE: "missing" }),
    /native_tls_required/
  )
  assert.equal(listenerOptions({}).hostname, "127.0.0.1")
})

test("native URL, exact Origin, fetch metadata, JSON and method gates", () => {
  for (const bad of [
    new Request("http://atlas.example.test/api/overview", {
      headers: { "x-forwarded-proto": "https" },
    }),
    new Request("https://evil.test/api/overview"),
    request("/api/overview", "GET", { "sec-fetch-site": "cross-site" }),
    request("/api/overview", "POST", { origin: "https://evil.test" }, "{}"),
    request("/api/overview", "POST", { "content-type": "text/plain" }, "{}"),
    request("/api/overview", "OPTIONS"),
  ])
    assert(requestBoundaryError(bad, config) instanceof Response)
  assert.equal(
    requestBoundaryError(
      new Request(origin + "/api/overview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      config
    )?.status,
    403
  )
  assert.equal(
    requestBoundaryError(request("/api/overview", "POST", {}, "{}"), config),
    null
  )
  const callback = "/api/settings/connections/google/callback?state=synthetic"
  assert.equal(
    requestBoundaryError(
      request(callback, "GET", {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      }),
      config
    ),
    null
  )
  assert.equal(
    requestBoundaryError(
      request(callback, "GET", {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
      }),
      config
    )?.status,
    403
  )
})

test("missing config, DB failure, missing session and alien owner deny access", async () => {
  assert.equal(
    (
      await createAdminBoundary(null, null).handler(
        request("/api/auth/get-session")
      )
    ).status,
    503
  )
  for (const [data, status] of [
    [null, 401],
    [{ ...owner(), user: { ...owner().user, id: "alien" } }, 403],
    [{ ...owner(), session: { ...owner().session, userId: "alien" } }, 403],
  ] as const) {
    const r = await createAdminBoundary(
      config,
      backend(data),
      () => current
    ).getOwner(request())
    assert(r instanceof Response)
    assert.equal(r.status, status)
  }
  const r = await createAdminBoundary(
    config,
    {
      ...backend(),
      getSession: async () => {
        throw new Error("private driver detail")
      },
    },
    () => current
  ).getOwner(request())
  assert(r instanceof Response)
  assert.equal(r.status, 503)
  assert(!(await r.text()).includes("private"))
})

test("expiration, future timestamps, fixed lifetime and freshness are enforced", async () => {
  for (const data of [
    owner(SESSION_SECONDS * 1000),
    owner(-1),
    {
      ...owner(),
      session: { ...owner().session, expiresAt: new Date(current) },
    },
    { ...owner(), session: { ...owner().session, createdAt: new Date(NaN) } },
  ]) {
    const r = await createAdminBoundary(
      config,
      backend(data),
      () => current
    ).getOwner(request())
    assert(r instanceof Response)
    assert.equal(r.status, 401)
  }
  const b = createAdminBoundary(
    config,
    backend(owner(FRESH_SECONDS * 1000)),
    () => current
  )
  assert(!((await b.getOwner(request())) instanceof Response))
  assert((await b.getOwner(request(), true)) instanceof Response)
})

test("Hono context carries the DB session ID and hides identity outside middleware", async () => {
  const b = createAdminBoundary(config, backend(), () => current),
    app = new Hono()
  app.use("/api/*", b.requireOwner)
  app.post("/api/settings/test", b.requireFreshOwner, (c) =>
    c.json({ id: b.sessionId(c) })
  )
  const r = await app.fetch(request("/api/settings/test", "POST", {}, "{}"))
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { id: "database-session-id" })
  assert.equal(r.headers.get("cache-control"), "no-store")
})

test("only reviewed auth routes are exposed and response bodies cannot leak tokens", async () => {
  const b = createAdminBoundary(config, backend(), () => current)
  for (const path of [
    "sign-up/email",
    "reset-password",
    "sign-in/social",
    "list-sessions",
    "token",
    "get-session",
  ])
    assert.equal(
      (await b.handler(request("/api/auth/" + path, "POST", {}, "{}"))).status,
      404
    )
  const session = await b.handler(request("/api/auth/get-session"))
  const json = await session.json()
  assert(json && typeof json === "object" && "session" in json)
  assert(json.session && typeof json.session === "object")
  assert(!("token" in json.session))
  assert(!("userId" in json.session))
  const login = await b.handler(
    request(
      "/api/auth/sign-in/email",
      "POST",
      {},
      JSON.stringify({
        email: "Owner@EXAMPLE.test",
        password: "synthetic-password",
      })
    )
  )
  assert.deepEqual(await login.json(), { success: true })
  assert.equal(login.headers.getSetCookie().length, 1)
})

test("normalized password changes force revocation; inputs and size are bounded", async () => {
  let calls = 0
  const b = createAdminBoundary(
    config,
    backend(owner(), async (r) => {
      calls++
      assert.deepEqual(await r.json(), {
        currentPassword: "old-password",
        newPassword: "synthetic-new-password",
        revokeOtherSessions: true,
      })
      return Response.json({ token: "never" })
    }),
    () => current
  )
  const r = await b.handler(
    request(
      "/api/auth/change-password",
      "POST",
      {},
      JSON.stringify({
        currentPassword: "old-password",
        newPassword: "synthetic-new-password",
        revokeOtherSessions: false,
      })
    )
  )
  assert.equal(r.status, 200)
  assert.equal(calls, 1)
  for (const [body, status] of [
    ["[]", 400],
    ["{", 400],
    [
      JSON.stringify({
        email: "a",
        password: "p",
        callbackURL: "https://evil.test",
      }),
      400,
    ],
    [JSON.stringify({ email: "a", password: "x".repeat(17000) }), 413],
  ] as const)
    assert.equal(
      (await b.handler(request("/api/auth/sign-in/email", "POST", {}, body)))
        .status,
      status
    )
  assert.equal(calls, 1)
})

test("process-wide rate buckets cannot be bypassed by spoofed IP headers", async () => {
  let time = current
  const b = createAdminBoundary(config, backend(), () => time)
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await b.handler(
          request(
            "/api/auth/sign-in/email",
            "POST",
            { "x-forwarded-for": "192.0.2." + i },
            JSON.stringify({
              email: "o@example.test",
              password: "synthetic-password",
            })
          )
        )
      ).status,
      200
    )
  assert.equal(
    (await b.handler(request("/api/auth/sign-in/email", "POST", {}, "{}")))
      .status,
    429
  )
  time += 60_000
  assert.equal(
    (await b.handler(request("/api/auth/sign-in/email", "POST", {}, "{}")))
      .status,
    400
  )
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await b.handler(
          request(
            "/api/auth/change-password",
            "POST",
            {},
            JSON.stringify({
              currentPassword: "synthetic-old",
              newPassword: "synthetic-new-password",
            })
          )
        )
      ).status,
      200
    )
  assert.equal(
    (await b.handler(request("/api/auth/change-password", "POST", {}, "{}")))
      .status,
    429
  )
})
