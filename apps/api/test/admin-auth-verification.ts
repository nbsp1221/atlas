import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { z } from "zod"
import { eq, sql } from "drizzle-orm"
import {
  createDatabase,
  authUser,
  authAccount,
  authSession,
  credentialSecrets,
} from "@workspace/db"
import { GOOGLE_SCOPES } from "@workspace/integrations"
import { createApplication } from "../src/app"
import { createAdminAuth } from "../src/auth"
import { provisionOwner } from "../src/auth/provision-owner"
import {
  defaultProviderOperations,
  type ProviderOperations,
} from "../src/connections/service"
import {
  verificationDatabaseUrl,
  verificationPostgresArgs,
} from "../../../scripts/verification-isolation.mjs"

const runId = process.env.VERIFICATION_RUN_ID
if (
  !runId ||
  process.env.DATABASE_URL !== verificationDatabaseUrl("runtime", runId)
)
  throw new Error("Refusing non-isolated auth database")
const { db, client } = createDatabase(process.env.DATABASE_URL)
const origin = "https://atlas.example.test"
const password = "synthetic-owner-password-only"
const nextPassword = "synthetic-next-password-only"
const env = {
  ATLAS_PUBLIC_URL: origin,
  ATLAS_AUTH_SECRET: randomBytes(48).toString("base64url"),
  ATLAS_CREDENTIAL_ACTIVE_KEY: "fixture",
  ATLAS_CREDENTIAL_KEYS: JSON.stringify({
    fixture: randomBytes(32).toString("base64"),
  }),
}
const provider: ProviderOperations = {
  ...defaultProviderOperations,
  checkOpenAI: async () => ({
    principalType: null,
    principalId: null,
    scopes: ["models.list"],
  }),
  exchangeGoogleCode: async () => ({
    accessToken: "synthetic-google-access",
    refreshToken: "synthetic-google-refresh",
    expiresAt: Date.now() + 3600000,
    scopes: GOOGLE_SCOPES,
  }),
  checkGoogle: async (t) => ({
    principalType: "google-sub",
    principalId: "synthetic-google-sub",
    scopes: t.scopes,
  }),
}
try {
  const registrations = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      provisionOwner(db, {
        email: "owner@example.test",
        name: "Fixture owner",
        password,
      })
    )
  )
  assert.equal(registrations.filter((x) => x.status === "fulfilled").length, 1)
  assert.equal((await db.select().from(authUser)).length, 1)
  assert.equal((await db.select().from(authAccount)).length, 1)
  await assert.rejects(() =>
    db
      .insert(authUser)
      .values({ id: "another-owner", name: "x", email: "x@example.test" })
  )
  await assert.rejects(() =>
    db.insert(authAccount).values({
      id: "social",
      accountId: "atlas-owner",
      userId: "atlas-owner",
      providerId: "google",
      password: "invalid",
    })
  )
  console.log(
    "Single-owner constraints, concurrent provisioning and rollback: PASS"
  )

  const { app } = await createApplication(db, env, provider)
  const req = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {}
  ) =>
    app.fetch(
      new Request(origin + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method !== "GET"
            ? { origin, "content-type": "application/json" }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )
  for (const path of [
    "/api",
    "/api/overview",
    "/api/automations",
    "/api/runs",
    "/api/connections",
    "/api/code-automations/email-summary",
    "/api/settings/connections",
    "/api/settings/automations/email-triage/connections",
  ])
    assert.equal((await req(path)).status, 401, path)
  for (const path of [
    "/api/code-automations/email-summary/test-runs",
    "/api/automations/email-triage/test-runs",
    "/api/settings/connections/api-key",
    "/api/settings/automations/email-triage/connections",
  ])
    assert.equal((await req(path, "POST", {})).status, 401, path)
  assert.equal(
    (
      await app.fetch(
        new Request("http://atlas.example.test/api/overview", {
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "atlas.example.test",
          },
        })
      )
    ).status,
    403
  )
  for (const path of [
    "sign-up/email",
    "sign-in/social",
    "list-sessions",
    "reset-password",
  ])
    assert.equal((await req("/api/auth/" + path, "POST", {})).status, 404)
  console.log(
    "All API reads/runs/Settings protected; signup, HTTP and spoofed ingress rejected: PASS"
  )

  async function login(value = password) {
    const response = await req("/api/auth/sign-in/email", "POST", {
      email: "owner@example.test",
      password: value,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true })
    const cookies = response.headers.getSetCookie()
    assert.equal(cookies.length, 1)
    assert.match(cookies[0], /HttpOnly/i)
    assert.match(cookies[0], /Secure/i)
    assert.match(cookies[0], /SameSite=Lax/i)
    assert(!/Domain=/i.test(cookies[0]))
    return cookies.map((x) => x.split(";")[0]).join("; ")
  }
  const first = await login(),
    second = await login()
  const sessionResponse = await req(
    "/api/auth/get-session",
    "GET",
    undefined,
    first
  )
  const session = z
    .object({
      session: z.object({ id: z.string() }).passthrough(),
    })
    .parse(await sessionResponse.json())
  assert.deepEqual(Object.keys(session.session).sort(), [
    "createdAt",
    "expiresAt",
    "id",
  ])
  assert.equal(
    (await req("/api/overview", "GET", undefined, first)).status,
    200
  )
  assert.equal(
    (await req("/api/settings/connections", "GET", undefined, first)).status,
    200
  )
  assert.equal(
    (
      await req(
        "/api/settings/connections/api-key",
        "POST",
        {
          providerKey: "openai",
          label: "Fixture reusable model",
          secret: "synthetic-model-key-only",
        },
        first,
        { origin: "https://evil.test" }
      )
    ).status,
    403
  )
  const added = await req(
    "/api/settings/connections/api-key",
    "POST",
    {
      providerKey: "openai",
      label: "Fixture reusable model",
      secret: "synthetic-model-key-only",
    },
    first
  )
  assert.equal(added.status, 201)
  const addedText = await added.text()
  assert(!addedText.includes("synthetic-model-key-only"))
  const rows = await db.select().from(credentialSecrets)
  assert(rows.length > 0)
  assert(!JSON.stringify(rows).includes("synthetic-model-key-only"))
  console.log(
    "Real Better Auth login/cookies, safe session DTO and encrypted authenticated Settings: PASS"
  )

  await db
    .update(authSession)
    .set({ createdAt: new Date(Date.now() - 16 * 60000) })
    .where(eq(authSession.id, session.session.id))
  assert.equal(
    (
      await req(
        "/api/settings/connections/api-key",
        "POST",
        { providerKey: "openai", label: "denied", secret: "synthetic-denied" },
        first
      )
    ).status,
    403
  )
  assert.equal(
    (await req("/api/settings/connections", "GET", undefined, first)).status,
    200
  )
  await db
    .update(authSession)
    .set({ createdAt: new Date() })
    .where(eq(authSession.id, session.session.id))

  const saved = await req(
    "/api/settings/oauth-clients/google",
    "PUT",
    {
      clientId: "fixture.apps.googleusercontent.com",
      clientSecret: "synthetic-google-client",
    },
    first
  )
  assert.equal(saved.status, 200)
  async function authorize(cookie = first) {
    const response = await req(
      "/api/settings/connections/google/authorize",
      "POST",
      { label: "Fixture mailbox" },
      cookie
    )
    assert.equal(response.status, 200)
    const data = z
      .object({ authorizationUrl: z.url() })
      .parse(await response.json())
    return new URL(data.authorizationUrl).searchParams.get("state")!
  }
  const state = await authorize()
  const foreign = await req(
    "/api/settings/connections/google/callback?state=" +
      state +
      "&code=fixture",
    "GET",
    undefined,
    second,
    {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    }
  )
  assert.equal(foreign.headers.get("location"), "/connections?oauth=failed")
  const state2 = await authorize()
  const callback = await req(
    "/api/settings/connections/google/callback?state=" +
      state2 +
      "&code=fixture",
    "GET",
    undefined,
    first,
    {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    }
  )
  assert.equal(callback.status, 303)
  assert.equal(callback.headers.get("location"), "/connections?oauth=complete")
  assert.equal(
    (
      await req(
        "/api/settings/connections/google/callback?state=" +
          state2 +
          "&code=fixture",
        "GET",
        undefined,
        first
      )
    ).headers.get("location"),
    "/connections?oauth=failed"
  )
  console.log(
    "Authenticated cross-site OAuth navigation, session mismatch and replay denial: PASS"
  )

  const oldAccount = (await db.select().from(authAccount))[0]
  const oldSessions = await db.select().from(authSession)
  await db.execute(
    sql`create function fixture_reject_new_session() returns trigger language plpgsql as $$ begin raise exception 'synthetic session insertion fault'; end $$`
  )
  await db.execute(
    sql`create trigger fixture_reject_new_session before insert on auth_session for each row execute function fixture_reject_new_session()`
  )
  const originalError = console.error
  let rawErrors = 0
  console.error = () => {
    rawErrors++
  }
  let failed: Response
  try {
    failed = await req(
      "/api/auth/change-password",
      "POST",
      {
        currentPassword: password,
        newPassword: nextPassword,
        revokeOtherSessions: false,
      },
      first
    )
  } finally {
    console.error = originalError
  }
  assert.equal(rawErrors, 0, "Library must not log raw SQL/session errors")
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.getSetCookie().length, 0)
  assert.equal(
    (await db.select().from(authAccount))[0].password,
    oldAccount.password
  )
  assert.deepEqual(await db.select().from(authSession), oldSessions)
  await db.execute(sql`drop trigger fixture_reject_new_session on auth_session`)
  await db.execute(sql`drop function fixture_reject_new_session()`)
  const changed = await req(
    "/api/auth/change-password",
    "POST",
    {
      currentPassword: password,
      newPassword: nextPassword,
      revokeOtherSessions: false,
    },
    first
  )
  assert.equal(changed.status, 200)
  assert.deepEqual(await changed.json(), { success: true })
  const replacement = changed.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join("; ")
  assert.equal(
    (await req("/api/overview", "GET", undefined, first)).status,
    401
  )
  assert.equal(
    (await req("/api/overview", "GET", undefined, second)).status,
    401
  )
  assert.equal(
    (await req("/api/overview", "GET", undefined, replacement)).status,
    200
  )
  assert.equal((await db.select().from(authSession)).length, 1)
  const badLogin = await req("/api/auth/sign-in/email", "POST", {
    email: "owner@example.test",
    password,
  })
  assert.equal(badLogin.status, 401)
  const latest = await login(nextPassword)
  assert.equal(
    (await req("/api/auth/sign-out", "POST", {}, latest)).status,
    200
  )
  assert.equal(
    (await req("/api/overview", "GET", undefined, latest)).status,
    401
  )
  console.log(
    "Password-change fault rollback, forced revocation/session replacement and logout: PASS"
  )

  const remaining = (await db.select().from(authSession))[0]
  await db
    .update(authSession)
    .set({ expiresAt: new Date(Date.now() - 1) })
    .where(eq(authSession.id, remaining.id))
  assert.equal(
    (await req("/api/overview", "GET", undefined, replacement)).status,
    401
  )
  const unconfigured = createAdminAuth(db, {})
  assert.equal(
    (await unconfigured.handler(new Request(origin + "/api/auth/get-session")))
      .status,
    503
  )
  const restarted = await createApplication(db, env, provider)
  assert.equal(
    (
      await restarted.app.fetch(
        new Request(origin + "/api/overview", {
          headers: { cookie: replacement },
        })
      )
    ).status,
    401
  )
  await assert.rejects(
    () =>
      createApplication(db, {
        ...env,
        ATLAS_CREDENTIAL_KEYS: JSON.stringify({
          fixture: randomBytes(32).toString("base64"),
        }),
      }),
    /credential_storage_validation_failed/
  )
  console.log(
    "Expiry, restart revocation and wrong-key startup rejection: PASS"
  )
  assert.equal(
    process.env.RESTORE_DATABASE_URL,
    verificationDatabaseUrl("upgrade", runId)
  )
  const dump = spawnSync(
    "docker",
    verificationPostgresArgs([
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "postgres",
      "--no-owner",
      "--no-acl",
      "--format=custom",
      `control_plane_verify_runtime_${runId}`,
    ]),
    { maxBuffer: 32 * 1024 * 1024 }
  )
  assert.equal(dump.status, 0, "Auth fixture backup failed")
  const restore = spawnSync(
    "docker",
    verificationPostgresArgs([
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "-U",
      "postgres",
      "--no-owner",
      "--no-acl",
      "-d",
      `control_plane_verify_upgrade_${runId}`,
    ]),
    { input: dump.stdout, maxBuffer: 32 * 1024 * 1024 }
  )
  assert.equal(restore.status, 0, "Auth fixture restore failed")
  const restored = createDatabase(process.env.RESTORE_DATABASE_URL!)
  try {
    assert.deepEqual(
      await restored.db.select().from(authUser),
      await db.select().from(authUser)
    )
    assert.deepEqual(
      await restored.db.select().from(authAccount),
      await db.select().from(authAccount)
    )
    assert.deepEqual(
      await restored.db.select().from(authSession),
      await db.select().from(authSession)
    )
    const restoredApp = await createApplication(restored.db, env, provider)
    assert.equal(
      (
        await restoredApp.app.fetch(
          new Request(origin + "/api/overview", {
            headers: { cookie: replacement },
          })
        )
      ).status,
      401
    )
  } finally {
    await restored.client.end()
  }
  console.log(
    "Auth rows and encrypted Connections backup/restore with separate key fixture: PASS"
  )
} finally {
  await client.end()
}
