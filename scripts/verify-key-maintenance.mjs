import { verificationPostgresArgs } from "./verification-isolation.mjs"
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
    throw new Error("Isolated key maintenance verification failed")
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
try {
  const env = {
    DATABASE_URL: databases.create("runtime"),
    VERIFICATION_RUN_ID: databases.runId,
  }
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], env)
  run(
    "pnpm",
    ["--filter", "api", "exec", "tsx", "test/key-maintenance-isolated.ts"],
    env
  )
} finally {
  databases.cleanup()
}
console.log("Independent isolated key-maintenance verification: PASS")
