import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import net from "node:net"
import test from "node:test"
import {
  apiProxyTarget,
  assertPortAvailable,
  createVerificationRunId,
  ownedVerificationDatabases,
  verificationDatabaseName,
  verificationDatabaseUrl,
  verificationServerConfig,
  verificationWebServers,
} from "../verification-isolation.mjs"

const runId = "a".repeat(24)
const environment = {
  VERIFICATION_RUN_ID: runId,
  DATABASE_URL: verificationDatabaseUrl("e2e", runId),
}
const root = new URL("../../", import.meta.url)

test("database names are unique, bounded PostgreSQL identifiers", () => {
  const ids = Array.from({ length: 100 }, () => createVerificationRunId())
  assert.equal(new Set(ids).size, 100)
  for (const id of ids) {
    for (const purpose of ["schema", "runtime", "e2e", "upgrade"]) {
      const name = verificationDatabaseName(purpose, id)
      assert.match(name, /^control_plane_verify_[a-z0-9]+_[a-f0-9]{24}$/)
      assert.ok(name.length <= 63)
    }
  }
  for (const bad of [
    "",
    "control_plane",
    "../x",
    "a;DROP DATABASE control_plane",
    "A".repeat(24),
    "a".repeat(24) + "\n",
  ]) {
    assert.throws(() => verificationDatabaseName("e2e", bad))
  }
  assert.throws(() => verificationDatabaseName("control_plane", runId))
})

test("a preexisting database collision is never adopted or dropped", () => {
  const commands = []
  const dbs = ownedVerificationDatabases((sql) => {
    commands.push(sql)
    throw new Error("already exists")
  }, runId)
  assert.throws(() => dbs.create("e2e"), /already exists/)
  dbs.cleanup()
  assert.deepEqual(commands, [
    `CREATE DATABASE ${verificationDatabaseName("e2e", runId)};`,
  ])
})

test("cleanup drops only databases successfully created by this run", () => {
  const commands = []
  const dbs = ownedVerificationDatabases((sql) => {
    commands.push(sql)
    if (sql.startsWith("CREATE") && sql.includes("_runtime_"))
      throw new Error("collision")
  }, runId)
  assert.equal(dbs.create("schema"), verificationDatabaseUrl("schema", runId))
  assert.throws(() => dbs.create("runtime"))
  dbs.cleanup()
  dbs.cleanup()
  assert.deepEqual(commands, [
    `CREATE DATABASE ${verificationDatabaseName("schema", runId)};`,
    `CREATE DATABASE ${verificationDatabaseName("runtime", runId)};`,
    `DROP DATABASE ${verificationDatabaseName("schema", runId)};`,
  ])
})

test("cleanup attempts all owned databases and reports failure without FORCE", () => {
  const commands = []
  const dbs = ownedVerificationDatabases((sql) => {
    commands.push(sql)
    if (sql.startsWith("DROP") && sql.includes("_schema_"))
      throw new Error("still connected")
  }, runId)
  dbs.create("schema")
  dbs.create("e2e")
  assert.throws(() => dbs.cleanup(), /cleanup failed/)
  assert.equal(commands.filter((sql) => sql.startsWith("DROP")).length, 2)
  assert.ok(
    commands.every(
      (sql) => !sql.includes("FORCE") && !sql.includes("IF EXISTS")
    )
  )
})

test("missing, canonical, wrong-run and alternate-host DB bindings fail closed", () => {
  for (const env of [
    {},
    { ...environment, VERIFICATION_RUN_ID: undefined },
    { ...environment, DATABASE_URL: undefined },
    {
      ...environment,
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/control_plane",
    },
    { ...environment, DATABASE_URL: verificationDatabaseUrl("runtime", runId) },
    {
      ...environment,
      DATABASE_URL: verificationDatabaseUrl("e2e", "b".repeat(24)),
    },
    {
      ...environment,
      DATABASE_URL: environment.DATABASE_URL.replace(
        new URL(environment.DATABASE_URL).hostname,
        "example.org"
      ),
    },
    {
      ...environment,
      DATABASE_URL: environment.DATABASE_URL + "?options=unsafe",
    },
  ]) {
    assert.throws(() => verificationServerConfig(env))
  }
})

test("API, web readiness, child DB binding and Vite proxy stay aligned", () => {
  const env = {
    ...environment,
    VERIFY_API_PORT: "45001",
    VERIFY_WEB_PORT: "45174",
  }
  const config = verificationServerConfig(env)
  const servers = verificationWebServers(env)
  assert.equal(config.apiUrl, "http://127.0.0.1:45001")
  assert.equal(config.webUrl, "http://127.0.0.1:45174")
  assert.equal(servers[0].url, config.apiUrl + "/health")
  assert.equal(servers[1].url, config.webUrl)
  for (const server of servers) {
    assert.equal(server.reuseExistingServer, false)
    assert.equal(server.env.DATABASE_URL, environment.DATABASE_URL)
    assert.equal(server.env.API_PORT, "45001")
    assert.equal(apiProxyTarget(server.env), config.apiUrl)
  }
  assert.equal(apiProxyTarget({}), "http://127.0.0.1:3001")
})

test("canonical, equal, invalid and mismatched ports are refused", () => {
  for (const patch of [
    { VERIFY_API_PORT: "3001" },
    { VERIFY_WEB_PORT: "4174" },
    { VERIFY_API_PORT: "4174" },
    { VERIFY_WEB_PORT: "3001" },
    { VERIFY_API_PORT: "44174" },
    { VERIFY_API_PORT: "0" },
    { VERIFY_API_PORT: "65536" },
    { VERIFY_API_PORT: "12x" },
    { VERIFY_WEB_PORT: "" },
    { API_PORT: "3001" },
  ])
    assert.throws(() => verificationServerConfig({ ...environment, ...patch }))
})

test("an occupied port is rejected without connecting to or reusing its listener", async () => {
  let connections = 0
  const listener = net.createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = listener.address().port
  try {
    await assert.rejects(
      assertPortAvailable(port),
      /occupied; refusing to reuse/
    )
    assert.equal(connections, 0)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
  await assertPortAvailable(port)
})

test("the actual server launcher refuses occupied API and web ports before spawning", async () => {
  const listener = net.createServer()
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const occupied = String(listener.address().port)
  try {
    for (const target of ["api", "web"]) {
      const env = {
        ...process.env,
        ...environment,
        API_PORT: target === "api" ? occupied : "43001",
        VERIFY_API_PORT: target === "api" ? occupied : "43001",
        VERIFY_WEB_PORT: target === "web" ? occupied : "44174",
      }
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["scripts/start-verification-server.mjs", target],
          { cwd: root, env }
        )
        let output = ""
        child.stderr.on("data", (chunk) => {
          output += chunk
        })
        child.once("error", reject)
        child.once("exit", (code) => resolve({ code, output }))
      })
      assert.equal(result.code, 1)
      assert.match(result.output, /occupied; refusing to reuse/)
    }
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
})

test("Turbo forwards every isolation variable and disables test caching", () => {
  const turbo = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"))
  for (const key of [
    "DATABASE_URL",
    "VERIFICATION_RUN_ID",
    "VERIFY_API_PORT",
    "VERIFY_WEB_PORT",
    "API_PORT",
  ]) {
    assert.ok(turbo.tasks.test.env.includes(key), key)
  }
  assert.equal(turbo.tasks.test.cache, false)
})

test("Playwright and Vite use the shared isolation policy and Vite starts in strict-port mode", () => {
  const playwright = readFileSync(
    new URL("apps/web/playwright.config.ts", root),
    "utf8"
  )
  const vite = readFileSync(new URL("apps/web/vite.config.ts", root), "utf8")
  const launcher = readFileSync(
    new URL("scripts/start-verification-server.mjs", root),
    "utf8"
  )
  assert.match(playwright, /webServer: verificationWebServers\(process.env\)/)
  assert.match(playwright, /baseURL: config.webUrl/)
  assert.match(vite, /target: apiProxyTarget\(process.env\)/)
  assert.match(launcher, /"--strictPort"/)
})
