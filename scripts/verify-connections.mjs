import { verificationPostgresArgs } from "./verification-isolation.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { ownedVerificationDatabases } from "./verification-isolation.mjs"
function run(command, args, env = {}) {
  if (command === "docker") args = verificationPostgresArgs(args)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `Connections verification failed: ${command} (exit ${result.status})`
    )
}
const databases = ownedVerificationDatabases((sql) =>
  run("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ])
)
const fixtureRoot = mkdtempSync(join(tmpdir(), "atlas-connections-"))
try {
  const url = databases.create("runtime"),
    env = {
      DATABASE_URL: url,
      VERIFICATION_RUN_ID: databases.runId,
      ATLAS_FAKE_MAILBOX_DIR: fixtureRoot,
      RESTORE_DATABASE_URL: databases.create("upgrade"),
    }
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], env)
  run("pnpm", ["--filter", "api", "bootstrap"], env)
  run("pnpm", ["--filter", "api", "runtime:verify"], env)
  run(
    "pnpm",
    ["--filter", "api", "exec", "tsx", "test/connections-verification.ts"],
    env
  )
} finally {
  databases.cleanup()
  rmSync(fixtureRoot, { recursive: true, force: true })
}
console.log("Isolated Connections verification: PASS")
