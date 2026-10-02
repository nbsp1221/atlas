import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { sql } from "drizzle-orm"
import { createDatabase } from "@workspace/db"
import { createApplication } from "../src/app"
import { provisionOwner } from "../src/auth/provision-owner"
import { verificationDatabaseUrl } from "../../../scripts/verification-isolation.mjs"

const runId = process.env.VERIFICATION_RUN_ID
if (
  !runId ||
  process.env.DATABASE_URL !== verificationDatabaseUrl("e2e", runId)
)
  throw new Error("Refusing non-isolated auth-race database")
const { db, client } = createDatabase(process.env.DATABASE_URL)
const origin = "https://atlas.example.test"
const passwords = Array.from({ length: 3 }, () =>
  randomBytes(24).toString("base64url")
)
try {
  await provisionOwner(db, {
    email: "race@example.test",
    name: "Race fixture",
    password: passwords[0],
  })
  const { app } = await createApplication(db, {
    ATLAS_PUBLIC_URL: origin,
    ATLAS_AUTH_SECRET: randomBytes(48).toString("base64url"),
  })
  const request = async (path: string, body?: unknown, cookie?: string) =>
    app.fetch(
      new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined
            ? {}
            : { origin, "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )
  const login = (password: string) =>
    request("/api/auth/sign-in/email", { email: "race@example.test", password })
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  const change = (
    cookie: string,
    currentPassword: string,
    newPassword: string
  ) =>
    request(
      "/api/auth/change-password",
      { currentPassword, newPassword, revokeOtherSessions: true },
      cookie
    )
  const first = await login(passwords[0])
  assert.equal(first.status, 200)
  let ownerCookie = cookieOf(first)

  // Only this disposable database receives these test triggers. Hold the first
  // mutation after its owner lock, then prove the second waits for that lock.
  await db.execute(sql`
    create function auth_race_gate() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(817331, 1); return NEW; end $$;
  `)
  async function waitFor(condition: () => Promise<boolean>) {
    const until = Date.now() + 10000
    while (Date.now() < until) {
      if (await condition()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("race_barrier_timeout")
  }
  async function orderedRace(
    firstRequest: () => Promise<Response>,
    secondRequest: () => Promise<Response>
  ) {
    let release!: () => void
    let locked!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(817331, 1)`)
      locked()
      await gate
    })
    await ready
    let firstPending: Promise<Response> | undefined
    let secondPending: Promise<Response> | undefined
    try {
      firstPending = firstRequest()
      await waitFor(async () => {
        const rows = await db.execute(
          sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and classid = 817331 and objid = 1 and not granted`
        )
        return rows[0]?.count === 1
      })
      secondPending = secondRequest()
      await waitFor(async () => {
        const rows = await db.execute(
          sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%auth_user%' and query like '%for update%'`
        )
        return Number(rows[0]?.count) >= 1
      })
      release()
      await blocker
      return await Promise.all([firstPending, secondPending])
    } finally {
      release()
      await blocker
      await Promise.allSettled([firstPending, secondPending].filter(Boolean))
    }
  }

  await db.execute(
    sql`create trigger auth_race_session before insert on auth_session for each row execute function auth_race_gate()`
  )
  const [racingLogin, changedAfterLogin] = await orderedRace(
    () => login(passwords[0]),
    () => change(ownerCookie, passwords[0], passwords[1])
  )
  assert.equal(racingLogin.status, 200)
  assert.equal(changedAfterLogin.status, 200)
  assert.equal(
    (await request("/api/overview", undefined, cookieOf(racingLogin))).status,
    401
  )
  assert.equal(
    (await request("/api/overview", undefined, ownerCookie)).status,
    401
  )
  ownerCookie = cookieOf(changedAfterLogin)
  assert.equal(
    (await request("/api/overview", undefined, ownerCookie)).status,
    200
  )
  await db.execute(sql`drop trigger auth_race_session on auth_session`)
  console.log(
    "Concurrent old-password login first: later password change revokes raced session: PASS"
  )

  await db.execute(
    sql`create trigger auth_race_password before update of password on auth_account for each row execute function auth_race_gate()`
  )
  const [changedBeforeLogin, rejectedLogin] = await orderedRace(
    () => change(ownerCookie, passwords[1], passwords[2]),
    () => login(passwords[1])
  )
  assert.equal(changedBeforeLogin.status, 200)
  assert.equal(rejectedLogin.status, 401)
  assert.equal(rejectedLogin.headers.getSetCookie().length, 0)
  assert.equal(
    (await request("/api/overview", undefined, ownerCookie)).status,
    401
  )
  assert.equal(
    (await request("/api/overview", undefined, cookieOf(changedBeforeLogin)))
      .status,
    200
  )
  assert.equal((await login(passwords[2])).status, 200)
  await db.execute(sql`drop trigger auth_race_password on auth_account`)
  await db.execute(sql`drop function auth_race_gate()`)
  console.log(
    "Concurrent password change first: queued old-password login rejected without cookie: PASS"
  )
} finally {
  await client.end()
}
